/**
 * GamificationOG — Streak Service (Section 24)
 * Streaks use the Time Engine for cadence, grace periods and freezes.
 * No hardcoded daily-streak algorithm — cadence is configuration.
 */
import { db } from '@/lib/db'
import { parseJson, type ActionDefinition } from '../core/types'
import { evaluateStreakGap } from '../time/engine'
import { executeActions } from '../engine/actions'

export interface StreakUpdateResult {
  key: string
  name: string
  evaluation: 'continue' | 'break' | 'same_period' | 'first'
  current: number
  best: number
  bestImproved: boolean
  milestoneHit: number | null
  multiplierApplied: number
}

export async function updateStreak(params: {
  streakId: string
  appUserId: string
  at: Date
  correlationId?: string
  eventId?: string
}): Promise<StreakUpdateResult | null> {
  const streak = await db.streak.findUnique({ where: { id: params.streakId } })
  if (!streak || streak.status !== 'active') return null

  const existing = await db.userStreak.findUnique({
    where: { streakId_appUserId: { streakId: streak.id, appUserId: params.appUserId } },
  })

  const last = existing?.lastQualifyingAt ?? null
  const evaluation = evaluateStreakGap(streak.cadence as 'daily' | 'weekly' | 'monthly', last, params.at, streak.gracePeriodHours)

  let current: number
  switch (evaluation) {
    case 'first':
      current = 1
      break
    case 'same_period':
      return {
        key: streak.key,
        name: streak.name,
        evaluation,
        current: existing?.currentCount ?? 0,
        best: existing?.bestCount ?? 0,
        bestImproved: false,
        milestoneHit: null,
        multiplierApplied: 1,
      }
    case 'continue':
      current = (existing?.currentCount ?? 0) + 1
      break
    case 'break':
      current = 1
      break
  }

  const bestBefore = existing?.bestCount ?? 0
  const best = Math.max(bestBefore, current)
  const bestImproved = current > bestBefore

  await db.userStreak.upsert({
    where: { streakId_appUserId: { streakId: streak.id, appUserId: params.appUserId } },
    create: {
      streakId: streak.id,
      appUserId: params.appUserId,
      currentCount: current,
      bestCount: best,
      lastQualifyingAt: params.at,
    },
    update: {
      currentCount: current,
      bestCount: best,
      lastQualifyingAt: params.at,
    },
  })

  // Milestone rewards
  const milestones = parseJson<Array<{ at: number; rewardsJson?: string; label?: string }>>(streak.milestonesJson, [])
  const milestone = milestones.find((m) => m.at === current) ?? null

  let milestoneHit: number | null = null
  if (milestone) {
    milestoneHit = milestone.at
    const rewardActions = parseJson<ActionDefinition[]>(milestone.rewardsJson ?? '[]', [])
    if (rewardActions.length > 0) {
      await executeActions(rewardActions, {
        projectId: streak.projectId,
        environmentId: streak.environmentId,
        appUserId: params.appUserId,
        source: 'streak',
        reference: streak.id,
        correlationId: params.correlationId,
        causationId: params.eventId,
        idempotencyKey: `streak:${streak.id}:${params.appUserId}:milestone:${current}`,
      })
    }
  }

  // Reward multiplier by streak count (e.g. {"7": 1.5} = 1.5x rewards at 7+)
  const multipliers = parseJson<Record<string, number>>(streak.rewardMultiplierJson, {})
  let multiplierApplied = 1
  const sortedKeys = Object.keys(multipliers).map(Number).sort((a, b) => b - a)
  for (const k of sortedKeys) {
    if (current >= k) {
      multiplierApplied = multipliers[String(k)]
      break
    }
  }

  return {
    key: streak.key,
    name: streak.name,
    evaluation,
    current,
    best,
    bestImproved,
    milestoneHit,
    multiplierApplied,
  }
}

/** Process an event for all matching streak definitions. */
export async function processEventForStreaks(params: {
  projectId: string
  environmentId: string
  appUserId: string
  eventType: string
  at: Date
  correlationId?: string
  eventId?: string
}): Promise<StreakUpdateResult[]> {
  const streaks = await db.streak.findMany({
    where: {
      projectId: params.projectId,
      environmentId: params.environmentId,
      eventType: params.eventType,
      status: 'active',
    },
  })

  const results: StreakUpdateResult[] = []
  for (const s of streaks) {
    const r = await updateStreak({
      streakId: s.id,
      appUserId: params.appUserId,
      at: params.at,
      correlationId: params.correlationId,
      eventId: params.eventId,
    })
    if (r) results.push(r)
  }
  return results
}

export async function getUserStreaks(appUserId: string) {
  const rows = await db.userStreak.findMany({
    where: { appUserId },
    include: { streak: true },
  })
  return rows.map((r) => ({
    key: r.streak.key,
    name: r.streak.name,
    cadence: r.streak.cadence,
    current: r.currentCount,
    best: r.bestCount,
    lastQualifyingAt: r.lastQualifyingAt,
    milestones: parseJson<Array<{ at: number; label?: string }>>(r.streak.milestonesJson, []),
  }))
}

/** Apply a streak freeze (skip a broken period once). */
export async function applyFreeze(params: { streakId: string; appUserId: string }) {
  const streak = await db.streak.findUnique({ where: { id: params.streakId } })
  if (!streak) return { frozen: false, reason: 'not_found' as const }
  const user = await db.userStreak.findUnique({
    where: { streakId_appUserId: { streakId: params.streakId, appUserId: params.appUserId } },
  })
  if (!user) return { frozen: false, reason: 'no_streak' as const }
  if (user.currentFreezeCount >= streak.freezeCount) {
    return { frozen: false, reason: 'no_freezes_left' as const }
  }
  await db.userStreak.update({
    where: { id: user.id },
    data: {
      currentFreezeCount: user.currentFreezeCount + 1,
      currentCount: Math.max(1, user.currentCount), // freeze preserves count
    },
  })
  return { frozen: true, reason: 'ok' as const }
}
