/**
 * GamificationOG — Identity Service (Section 9)
 * Anonymous/guest identity, identify + merge, sessions, API keys.
 * Anonymous account linking preserves progress on login (identity merge).
 */
import { createHash, randomUUID, randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { parseJson } from '../core/types'
import { PlatformError } from '../core/errors'

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

// ---------------------------------------------------------------------------
// App users (end users of customer products)
// ---------------------------------------------------------------------------

export async function identifyUser(params: {
  projectId: string
  environmentId: string
  externalId: string
  displayName?: string
  isAnonymous?: boolean
  attributes?: Record<string, unknown>
  provider?: string
  providerAccountId?: string
  mergeFromExternalId?: string // anonymous id to merge into this identity
}): Promise<{ appUserId: string; merged: boolean; created: boolean }> {
  const existing = await db.appUser.findUnique({
    where: {
      projectId_environmentId_externalId: {
        projectId: params.projectId,
        environmentId: params.environmentId,
        externalId: params.externalId,
      },
    },
  })

  if (existing && existing.status !== 'active') {
    throw new PlatformError({
      code: 'USER_NOT_ACTIVE',
      category: 'auth',
      message: `User "${params.externalId}" is ${existing.status}.`,
    })
  }

  let appUserId: string
  let created = false
  let merged = false

  if (existing) {
    appUserId = existing.id
    await db.appUser.update({
      where: { id: existing.id },
      data: {
        displayName: params.displayName ?? existing.displayName,
        isAnonymous: params.isAnonymous ?? existing.isAnonymous,
        lastSeenAt: new Date(),
        ...(params.attributes
          ? {
              attributesJson: JSON.stringify({
                ...parseJson<Record<string, unknown>>(existing.attributesJson, {}),
                ...params.attributes,
              }),
            }
          : {}),
      },
    })
  } else {
    const user = await db.appUser.create({
      data: {
        projectId: params.projectId,
        environmentId: params.environmentId,
        externalId: params.externalId,
        displayName: params.displayName ?? null,
        isAnonymous: params.isAnonymous ?? false,
        attributesJson: JSON.stringify(params.attributes ?? {}),
        lastSeenAt: new Date(),
      },
    })
    appUserId = user.id
    created = true
  }

  // link identity record
  if (params.provider) {
    await db.userIdentity.upsert({
      where: {
        provider_providerAccountId: {
          provider: params.provider,
          providerAccountId: params.providerAccountId ?? params.externalId,
        },
      },
      create: {
        appUserId,
        provider: params.provider,
        providerAccountId: params.providerAccountId ?? params.externalId,
        verified: !params.isAnonymous,
      },
      update: { verified: !params.isAnonymous },
    })
  }

  // anonymous -> identified merge (progress preserved)
  if (params.mergeFromExternalId && params.mergeFromExternalId !== params.externalId) {
    const anon = await db.appUser.findUnique({
      where: {
        projectId_environmentId_externalId: {
          projectId: params.projectId,
          environmentId: params.environmentId,
          externalId: params.mergeFromExternalId,
        },
      },
    })
    if (anon && anon.id !== appUserId && anon.isAnonymous) {
      await mergeUsers(params.projectId, params.environmentId, anon.id, appUserId)
      merged = true
    }
  }

  return { appUserId, merged, created }
}

/**
 * Identity merge: move all runtime state from source (anonymous) user to
 * target (identified) user. Progress is preserved (Section 9).
 */
export async function mergeUsers(projectId: string, environmentId: string, fromUserId: string, toUserId: string) {
  // Ledger: reattribute transactions, recompute wallet
  const ledger = await db.ledgerTransaction.findMany({ where: { appUserId: fromUserId } })
  for (const tx of ledger) {
    await db.ledgerTransaction.update({ where: { id: tx.id }, data: { appUserId: toUserId } })
  }
  // rebuild target wallets from combined ledger
  const currencies = await db.currency.findMany({ where: { projectId, environmentId } })
  for (const c of currencies) {
    const agg = await db.ledgerTransaction.aggregate({ where: { appUserId: toUserId, currencyId: c.id }, _sum: { amount: true } })
    const balance = agg._sum.amount ?? 0
    await db.walletBalance.upsert({
      where: { appUserId_currencyId: { appUserId: toUserId, currencyId: c.id } },
      create: { appUserId: toUserId, currencyId: c.id, balance },
      update: { balance },
    })
    await db.walletBalance.deleteMany({ where: { appUserId: fromUserId, currencyId: c.id } })
  }

  // Progression: sum XP
  const tracks = await db.progressionTrack.findMany({ where: { projectId, environmentId } })
  for (const t of tracks) {
    const fromP = await db.userProgression.findUnique({ where: { appUserId_trackId: { appUserId: fromUserId, trackId: t.id } } })
    const toP = await db.userProgression.findUnique({ where: { appUserId_trackId: { appUserId: toUserId, trackId: t.id } } })
    if (fromP) {
      const mergedXp = (toP?.xp ?? 0) + fromP.xp
      await db.userProgression.upsert({
        where: { appUserId_trackId: { appUserId: toUserId, trackId: t.id } },
        create: { appUserId: toUserId, trackId: t.id, xp: mergedXp, level: fromP.level },
        update: { xp: mergedXp },
      })
      await db.userProgression.deleteMany({ where: { appUserId: fromUserId, trackId: t.id } })
    }
  }

  // Items: sum quantities
  const fromItems = await db.userItem.findMany({ where: { appUserId: fromUserId } })
  for (const fi of fromItems) {
    const to = await db.userItem.findUnique({ where: { appUserId_itemId: { appUserId: toUserId, itemId: fi.itemId } } })
    if (to) {
      await db.userItem.update({ where: { id: to.id }, data: { quantity: to.quantity + fi.quantity } })
      await db.userItem.delete({ where: { id: fi.id } })
    } else {
      await db.userItem.update({ where: { id: fi.id }, data: { appUserId: toUserId } })
    }
  }

  // Achievements: move unlocks
  const fromAch = await db.userAchievement.findMany({ where: { appUserId: fromUserId } })
  for (const fa of fromAch) {
    const to = await db.userAchievement.findUnique({ where: { achievementId_appUserId: { achievementId: fa.achievementId, appUserId: toUserId } } })
    if (!to) {
      await db.userAchievement.update({ where: { id: fa.id }, data: { appUserId: toUserId } })
    } else {
      await db.userAchievement.delete({ where: { id: fa.id } })
    }
  }

  // Streaks: keep the better streak
  const fromStreaks = await db.userStreak.findMany({ where: { appUserId: fromUserId } })
  for (const fs of fromStreaks) {
    const to = await db.userStreak.findUnique({ where: { streakId_appUserId: { streakId: fs.streakId, appUserId: toUserId } } })
    if (!to) {
      await db.userStreak.update({ where: { id: fs.id }, data: { appUserId: toUserId } })
    } else {
      if (fs.currentCount > to.currentCount) {
        await db.userStreak.update({ where: { id: to.id }, data: { currentCount: fs.currentCount, bestCount: Math.max(fs.bestCount, to.bestCount), lastQualifyingAt: fs.lastQualifyingAt } })
      }
      await db.userStreak.delete({ where: { id: fs.id } })
    }
  }

  // Variables, notifications, challenge progress, leaderboard entries -> move
  await db.userVariable.updateMany({ where: { appUserId: fromUserId }, data: { appUserId: toUserId } }).catch(() => null)
  await db.notification.updateMany({ where: { appUserId: fromUserId }, data: { appUserId: toUserId } }).catch(() => null)
  await db.leaderboardEntry.updateMany({ where: { appUserId: fromUserId }, data: { appUserId: toUserId } }).catch(() => null)
  await db.experimentAssignment.updateMany({ where: { appUserId: fromUserId }, data: { appUserId: toUserId } }).catch(() => null)
  await db.event.updateMany({ where: { actorId: fromUserId }, data: { actorId: toUserId } }).catch(() => null)

  // Challenge progress: re-run upserts carefully (unique constraints)
  const fromChallenges = await db.challengeProgress.findMany({ where: { appUserId: fromUserId } })
  for (const fc of fromChallenges) {
    const to = await db.challengeProgress.findUnique({ where: { challengeId_appUserId_periodKey: { challengeId: fc.challengeId, appUserId: toUserId, periodKey: fc.periodKey } } })
    if (!to) {
      await db.challengeProgress.update({ where: { id: fc.id }, data: { appUserId: toUserId } })
    } else {
      await db.challengeProgress.update({ where: { id: to.id }, data: { progress: Math.max(to.progress, fc.progress) } })
      await db.challengeProgress.delete({ where: { id: fc.id } })
    }
  }

  // Deprecate the anonymous user
  await db.appUser.update({
    where: { id: fromUserId },
    data: { status: 'deleted', externalId: `__merged__${fromUserId}` },
  })
}

// ---------------------------------------------------------------------------
// User state snapshot (the SDK-facing aggregate)
// ---------------------------------------------------------------------------

export async function getUserStateSnapshot(params: {
  projectId: string
  environmentId: string
  externalId: string
}) {
  const user = await db.appUser.findUnique({
    where: {
      projectId_environmentId_externalId: {
        projectId: params.projectId,
        environmentId: params.environmentId,
        externalId: params.externalId,
      },
    },
  })
  if (!user) return null

  const { getUserProgression } = await import('../progression/service')
  const { getWalletBalances } = await import('../economy/service')
  const { getUserInventory } = await import('../inventory/service')
  const { getUserAchievements } = await import('../achievements/service')
  const { getUserChallenges } = await import('../challenges/service')
  const { getUserStreaks } = await import('../streaks/service')
  const { getUserNotifications } = await import('../notifications/service')

  const [progression, wallets, inventory, achievements, challenges, streaks, notifications] = await Promise.all([
    getUserProgression(user.id),
    getWalletBalances(user.id),
    getUserInventory(user.id),
    getUserAchievements(user.id, params.projectId, params.environmentId),
    getUserChallenges(user.id, params.projectId, params.environmentId, new Date()),
    getUserStreaks(user.id),
    getUserNotifications(user.id, 20),
  ])

  const variables = await db.userVariable.findMany({ where: { appUserId: user.id } })
  const varMap: Record<string, unknown> = {}
  for (const v of variables) varMap[v.key] = parseJson<unknown>(v.valueJson, null)

  return {
    user: {
      external_id: user.externalId,
      display_name: user.displayName,
      anonymous: user.isAnonymous,
      attributes: parseJson<Record<string, unknown>>(user.attributesJson, {}),
    },
    progression,
    wallets,
    inventory,
    achievements: achievements.filter((a) => !a.hidden),
    challenges,
    streaks,
    notifications,
    variables: varMap,
  }
}

// ---------------------------------------------------------------------------
// API keys (Section 187)
// ---------------------------------------------------------------------------

export interface GeneratedApiKey {
  id: string
  name: string
  key: string // shown once
  projectId: string
  environmentId: string
}

export async function createApiKey(params: {
  projectId: string
  environmentId: string
  name: string
  scopes?: string[]
}): Promise<GeneratedApiKey> {
  const secret = `gog_${randomBytes(24).toString('hex')}`
  const keyHash = hashSecret(secret)
  const keyPrefix = secret.slice(0, 12)

  const record = await db.apiKey.create({
    data: {
      projectId: params.projectId,
      environmentId: params.environmentId,
      name: params.name,
      keyPrefix,
      keyHash,
      scopesJson: JSON.stringify(params.scopes ?? ['events:write', 'state:read']),
    },
  })

  return {
    id: record.id,
    name: record.name,
    key: secret,
    projectId: record.projectId,
    environmentId: record.environmentId,
  }
}

export async function authenticateApiKey(secret: string) {
  if (!secret.startsWith('gog_')) return null
  const keyHash = hashSecret(secret)
  const record = await db.apiKey.findUnique({
    where: { keyHash },
    include: { project: { include: { workspace: true } } },
  })
  if (!record || record.status !== 'active') return null
  await db.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
  return {
    apiKeyId: record.id,
    projectId: record.projectId,
    environmentId: record.environmentId,
    scopes: parseJson<string[]>(record.scopesJson, []),
  }
}

// ---------------------------------------------------------------------------
// Dashboard admin auth
// ---------------------------------------------------------------------------

export function hashPassword(password: string, salt?: string): string {
  const s = salt ?? randomBytes(16).toString('hex')
  const hash = createHash('scrypt').update(s + password).digest('hex')
  return `${s}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = createHash('scrypt').update(salt + password).digest('hex')
  return candidate === hash
}

export async function createAdminSession(params: { userId: string; ip?: string; userAgent?: string }) {
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  const expiresAt = new Date(Date.now() + 7 * 86400000)
  await db.adminSession.create({
    data: {
      userId: params.userId,
      tokenHash: hashSecret(token),
      expiresAt,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
    },
  })
  return { token, expiresAt }
}

export async function authenticateAdminSession(token: string) {
  if (!token) return null
  const session = await db.adminSession.findUnique({
    where: { tokenHash: hashSecret(token) },
    include: { user: true },
  })
  if (!session || session.expiresAt < new Date()) return null
  if (session.user.status !== 'active') return null
  return {
    adminUserId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
  }
}

export async function destroyAdminSession(token: string) {
  await db.adminSession.deleteMany({ where: { tokenHash: hashSecret(token) } })
}
