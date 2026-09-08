/**
 * GamificationOG — Leaderboard & Ranking Engine (Section 29)
 * Leaderboards are systems, not screens: metric + algorithm + eligibility +
 * grouping + time window + tie breaker + reward policy. Ranking is
 * deterministic (Section 206).
 */
import { db } from '@/lib/db'
import { periodKeyFor, type TimeWindow } from '../time/engine'

export interface LeaderboardUpdateResult {
  leaderboard: string
  score: number
  rank: number | null
  rankBefore: number | null
  rankChanged: boolean
}

function metricValue(
  lb: { metricSource: string; payloadProperty: string | null },
  payload: Record<string, unknown>,
): number {
  switch (lb.metricSource) {
    case 'event_count':
      return 1
    case 'event_sum': {
      if (!lb.payloadProperty) return 1
      const v = payload[lb.payloadProperty]
      if (typeof v === 'number') return v
      if (typeof v === 'string') {
        const n = Number(v)
        if (!Number.isNaN(n)) return n
      }
      return 0
    }
    default:
      return 1
  }
}

/** Recompute dense ranks for a leaderboard + period. */
async function recomputeRanks(leaderboardId: string, periodKey: string, algorithm: string): Promise<void> {
  const entries = await db.leaderboardEntry.findMany({
    where: { leaderboardId, periodKey },
    orderBy: [
      { score: algorithm === 'lowest' ? 'asc' : 'desc' },
      // tie breaker: earliest reaches the position first
      { updatedAt: 'asc' },
    ],
    take: 5000,
  })

  await db.$transaction(
    entries.map((e, i) =>
      db.leaderboardEntry.update({
        where: { id: e.id },
        data: { rank: i + 1 },
      }),
    ),
  )
}

export async function updateLeaderboard(params: {
  leaderboardId: string
  appUserId: string
  delta: number
  at: Date
  mode?: 'increment' | 'set'
}): Promise<LeaderboardUpdateResult | null> {
  const lb = await db.leaderboard.findUnique({ where: { id: params.leaderboardId } })
  if (!lb || lb.status !== 'active') return null

  const periodKey = periodKeyFor(lb.timeWindow as TimeWindow, params.at)

  const existing = await db.leaderboardEntry.findUnique({
    where: { leaderboardId_appUserId_periodKey: { leaderboardId: lb.id, appUserId: params.appUserId, periodKey } },
  })

  const rankBefore = existing?.rank ?? null
  const newScore = params.mode === 'set'
    ? params.delta
    : (existing?.score ?? 0) + params.delta

  await db.leaderboardEntry.upsert({
    where: { leaderboardId_appUserId_periodKey: { leaderboardId: lb.id, appUserId: params.appUserId, periodKey } },
    create: {
      leaderboardId: lb.id,
      appUserId: params.appUserId,
      score: newScore,
      periodKey,
    },
    update: { score: newScore },
  })

  await recomputeRanks(lb.id, periodKey, lb.algorithm)

  const updated = await db.leaderboardEntry.findUnique({
    where: { leaderboardId_appUserId_periodKey: { leaderboardId: lb.id, appUserId: params.appUserId, periodKey } },
  })

  return {
    leaderboard: lb.name,
    score: newScore,
    rank: updated?.rank ?? null,
    rankBefore,
    rankChanged: (updated?.rank ?? 0) !== (rankBefore ?? 0),
  }
}

/** Process an event for matching leaderboards. */
export async function processEventForLeaderboards(params: {
  projectId: string
  environmentId: string
  appUserId: string
  eventType: string
  payload: Record<string, unknown>
  at: Date
}): Promise<LeaderboardUpdateResult[]> {
  const boards = await db.leaderboard.findMany({
    where: {
      projectId: params.projectId,
      environmentId: params.environmentId,
      status: 'active',
      metricSource: { in: ['event_count', 'event_sum'] },
      OR: [{ eventType: params.eventType }, { eventType: null }],
    },
  })

  const results: LeaderboardUpdateResult[] = []
  for (const lb of boards) {
    const delta = metricValue(lb, params.payload)
    if (delta === 0) continue
    const r = await updateLeaderboard({
      leaderboardId: lb.id,
      appUserId: params.appUserId,
      delta,
      at: params.at,
      mode: 'increment',
    })
    if (r) results.push(r)
  }
  return results
}

/** Publish an XP score to leaderboards sourcing from xp. */
export async function syncXpLeaderboards(params: {
  projectId: string
  environmentId: string
  appUserId: string
  xp: number
  at: Date
}): Promise<LeaderboardUpdateResult[]> {
  const boards = await db.leaderboard.findMany({
    where: {
      projectId: params.projectId,
      environmentId: params.environmentId,
      status: 'active',
      metricSource: 'xp',
    },
  })
  const results: LeaderboardUpdateResult[] = []
  for (const lb of boards) {
    const r = await updateLeaderboard({
      leaderboardId: lb.id,
      appUserId: params.appUserId,
      delta: params.xp,
      at: params.at,
      mode: 'set',
    })
    if (r) results.push(r)
  }
  return results
}

export async function getLeaderboardView(params: {
  leaderboardCode: string
  projectId: string
  environmentId: string
  at: Date
  limit?: number
  aroundUserId?: string
}) {
  const lb = await db.leaderboard.findUnique({
    where: { projectId_environmentId_code: { projectId: params.projectId, environmentId: params.environmentId, code: params.leaderboardCode } },
  })
  if (!lb) return null

  const periodKey = periodKeyFor(lb.timeWindow as TimeWindow, params.at)
  const entries = await db.leaderboardEntry.findMany({
    where: { leaderboardId: lb.id, periodKey },
    orderBy: [{ score: lb.algorithm === 'lowest' ? 'asc' : 'desc' }, { updatedAt: 'asc' }],
    take: params.limit ?? 100,
    include: { appUser: { select: { externalId: true, displayName: true } } },
  })

  let around: unknown = null
  if (params.aroundUserId) {
    const me = await db.leaderboardEntry.findUnique({
      where: { leaderboardId_appUserId_periodKey: { leaderboardId: lb.id, appUserId: params.aroundUserId, periodKey } },
      include: { appUser: { select: { externalId: true, displayName: true } } },
    })
    if (me) {
      around = {
        rank: me.rank,
        score: me.score,
        user: me.appUser.displayName ?? me.appUser.externalId,
        isSelf: true,
      }
    }
  }

  return {
    leaderboard: {
      code: lb.code,
      name: lb.name,
      timeWindow: lb.timeWindow,
      algorithm: lb.algorithm,
      metricSource: lb.metricSource,
    },
    periodKey,
    entries: entries.map((e, i) => ({
      rank: e.rank ?? i + 1,
      score: e.score,
      user: e.appUser.displayName ?? e.appUser.externalId,
      isSelf: e.appUserId === params.aroundUserId,
    })),
    around,
  }
}
