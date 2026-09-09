/**
 * GamificationOG — Context Engine (Section 12)
 * A rule should not only know that an event occurred — it evaluates a
 * complete context: user, event, project, environment, time, metrics,
 * segments, progression, economy, entitlements, experiment assignment.
 */
import { db } from '@/lib/db'
import { parseJson, type EngineContext } from '../core/types'
import { dateKey } from '../time/engine'
import { evaluateUserSegments, evaluateFeatureFlags, assignExperiments } from '../segments/service'
import { getLevelForContext } from '../progression/service'
import { getWalletBalances } from '../economy/service'
import { getUserInventory } from '../inventory/service'

export interface BuildContextParams {
  projectId: string
  environmentId: string
  appUserId: string
  event: {
    id: string
    type: string
    version: number
    payload: Record<string, unknown>
    occurredAt: Date
    source: string
  }
}

export async function buildEngineContext(params: BuildContextParams): Promise<{
  context: EngineContext
  raw: Record<string, unknown>
}> {
  const now = params.event.occurredAt

  const [user, project, environment] = await Promise.all([
    db.appUser.findUnique({ where: { id: params.appUserId } }),
    db.project.findUnique({ where: { id: params.projectId } }),
    db.environment.findUnique({ where: { id: params.environmentId } }),
  ])

  if (!user) throw new Error(`AppUser ${params.appUserId} not found`)
  if (!project) throw new Error(`Project ${params.projectId} not found`)

  const attributes = parseJson<Record<string, unknown>>(user.attributesJson, {})
  const userVars = await db.userVariable.findMany({ where: { appUserId: params.appUserId } })
  const variables: Record<string, unknown> = {}
  for (const v of userVars) {
    variables[v.key] = parseJson<unknown>(v.valueJson, null)
  }

  const progression = await getLevelForContext(params.appUserId, 'default')
  const balances = await getWalletBalances(params.appUserId)
  const inventory = await getUserInventory(params.appUserId)

  // Pre-segment context (attributes + progression + economy for segment rules)
  const preContext: Record<string, unknown> = {
    user: {
      id: user.id,
      external_id: user.externalId,
      display_name: user.displayName,
      anonymous: user.isAnonymous,
      status: user.status,
      created_at: user.createdAt.toISOString(),
      attribute: attributes,
      variable: variables,
      level: progression.level,
      xp: progression.xp,
      currency: Object.fromEntries(balances.map((b) => [b.currency, b.balance])),
      item: Object.fromEntries(inventory.map((i) => [i.code, i.quantity])),
    },
    event: {
      id: params.event.id,
      type: params.event.type,
      version: params.event.version,
      source: params.event.source,
      payload: params.event.payload,
    },
    project: { id: project.id, name: project.name },
    environment: { id: environment?.id, name: environment?.name ?? 'default' },
    time: {
      now: now.toISOString(),
      day_of_week: now.getUTCDay(),
      hour_of_day: now.getUTCHours(),
      date_key: dateKey(now),
      unix_seconds: Math.floor(now.getTime() / 1000),
    },
  }

  const segments = await evaluateUserSegments({
    projectId: params.projectId,
    environmentId: params.environmentId,
    context: preContext,
  })

  const flags = await evaluateFeatureFlags({
    projectId: params.projectId,
    environmentId: params.environmentId,
    appUserId: params.appUserId,
    segmentIds: segments.ids,
  })

  const experimentVariants = await assignExperiments({
    projectId: params.projectId,
    environmentId: params.environmentId,
    appUserId: params.appUserId,
  })

  const context: EngineContext = {
    event: {
      id: params.event.id,
      type: params.event.type,
      version: params.event.version,
      payload: params.event.payload,
      occurredAt: params.event.occurredAt,
      source: params.event.source,
    },
    user: {
      id: user.id,
      externalId: user.externalId,
      displayName: user.displayName,
      isAnonymous: user.isAnonymous,
      attributes,
      status: user.status,
      createdAt: user.createdAt,
    },
    project: {
      id: project.id,
      name: project.name,
      timezone: project.timezone ?? 'UTC',
    },
    environment: {
      id: environment?.id ?? '',
      name: environment?.name ?? 'default',
    },
    time: {
      now,
      dayOfWeek: now.getUTCDay(),
      hourOfDay: now.getUTCHours(),
      dateKey: dateKey(now),
      unixSeconds: Math.floor(now.getTime() / 1000),
    },
    progression: {
      tracks: [{ code: 'default', xp: progression.xp, level: progression.level }],
    },
    economy: {
      balances: balances.map((b) => ({ currency: b.currency, balance: b.balance })),
    },
    inventory: {
      items: inventory.map((i) => ({ code: i.code, quantity: i.quantity })),
    },
    segments: {
      ids: segments.ids,
      names: segments.names,
    },
    flags,
    experiment: experimentVariants,
    metrics: {},
  }

  // Final raw context for condition evaluation (includes segments + variables)
  const raw: Record<string, unknown> = {
    ...preContext,
    user: {
      ...(preContext.user as Record<string, unknown>),
      segment: segments.names,
    },
    flags,
    experiment: experimentVariants,
  }

  return { context, raw }
}
