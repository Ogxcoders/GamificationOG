/**
 * GET /api/admin/users — user explorer with full state details.
 * Query: ?externalId=... for a single user deep dive.
 */
import { NextRequest } from 'next/server'
import { json, apiError } from '@/lib/api'
import { db } from '@/lib/db'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { getUserStateSnapshot } from '@/server/identity/service'
import { parseJson } from '@/server/core/types'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const url = new URL(req.url)
    const externalId = url.searchParams.get('externalId')
    const q = url.searchParams.get('q')

    if (externalId) {
      const snapshot = await getUserStateSnapshot({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        externalId,
      })
      if (!snapshot) return json({ error: { code: 'NOT_FOUND', message: 'User not found.' } }, 404)

      const events = await db.event.findMany({
        where: { projectId: scope.projectId, environmentId: scope.environmentId, actorId: undefined },
        take: 0,
      }).catch(() => [])

      const ledger = await db.ledgerTransaction.findMany({
        where: { appUser: { externalId } },
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: { currency: true },
      })

      return json({
        state: snapshot,
        ledger: ledger.map((t) => ({
          id: t.id,
          currency: t.currency.code,
          amount: t.amount,
          type: t.type,
          source: t.source,
          balanceAfter: t.balanceAfter,
          createdAt: t.createdAt,
        })),
        events,
      })
    }

    const users = await db.appUser.findMany({
      where: {
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        ...(q ? { OR: [{ externalId: { contains: q } }, { displayName: { contains: q } }] } : {}),
      },
      orderBy: { lastSeenAt: 'desc' },
      take: 100,
      include: {
        progression: { include: { track: true } },
        walletBalances: { include: { currency: true } },
        userAchievements: { where: { unlockedAt: { not: null } }, include: { achievement: true } },
        userStreaks: { include: { streak: true } },
      },
    })

    return json({
      users: users.map((u) => ({
        id: u.id,
        externalId: u.externalId,
        displayName: u.displayName,
        anonymous: u.isAnonymous,
        status: u.status,
        attributes: parseJson<Record<string, unknown>>(u.attributesJson, {}),
        lastSeenAt: u.lastSeenAt,
        createdAt: u.createdAt,
        progression: u.progression.map((p) => ({ track: p.track.code, xp: p.xp, level: p.level })),
        wallets: u.walletBalances.map((w) => ({ currency: w.currency.code, balance: w.balance })),
        achievements: u.userAchievements.map((a) => ({
          code: a.achievement.code,
          name: a.achievement.name,
          unlockedAt: a.unlockedAt,
        })),
        streaks: u.userStreaks.map((s) => ({
          key: s.streak.key,
          current: s.currentCount,
          best: s.bestCount,
        })),
      })),
      scope,
    })
  } catch (e) {
    return apiError(e)
  }
}
