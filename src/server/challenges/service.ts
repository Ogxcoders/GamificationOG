/**
 * GamificationOG — Challenge Engine (Section 21)
 * A Challenge is a generic container for a measurable objective.
 * Progress sources: event_count, event_sum, unique_entities.
 * Period keys enable daily/weekly/monthly resets without hardcoding
 * "daily" (Time Engine owns temporal semantics).
 */
import { db } from '@/lib/db'
import { parseJson, type ActionDefinition } from '../core/types'
import { periodKeyFor } from '../time/engine'
import { executeActions } from '../engine/actions'
import { PlatformError } from '../core/errors'

export interface ChallengeUpdateResult {
  challenge: string
  progressBefore: number
  progressAfter: number
  target: number
  completed: boolean
  justCompleted: boolean
  rewardsGranted: ActionDefinition[]
}

function periodKeyForChallenge(challenge: { type: string }, at: Date): string {
  switch (challenge.type) {
    case 'daily': return periodKeyFor('daily', at)
    case 'weekly': return periodKeyFor('weekly', at)
    case 'monthly': return periodKeyFor('monthly', at)
    default: return 'all'
  }
}

/** Compute the progress delta an event contributes to a challenge. */
export function eventProgressDelta(
  challenge: { metricSource: string; payloadProperty: string | null; target: number },
  payload: Record<string, unknown>,
): number {
  switch (challenge.metricSource) {
    case 'event_count':
      return 1
    case 'event_sum': {
      if (!challenge.payloadProperty) return 1
      const v = payload[challenge.payloadProperty]
      if (typeof v === 'number') return v
      if (typeof v === 'string') {
        const n = Number(v)
        if (!Number.isNaN(n)) return n
      }
      return 0
    }
    case 'unique_entities':
      return 1 // uniqueness enforced upstream via subject tracking in payload
    default:
      return 1
  }
}

export async function updateChallengeProgress(params: {
  challengeId: string
  appUserId: string
  delta: number
  at: Date
  correlationId?: string
  eventId?: string
  uniqueSubject?: string | null
}): Promise<ChallengeUpdateResult | null> {
  const challenge = await db.challenge.findUnique({ where: { id: params.challengeId } })
  if (!challenge) return null

  const periodKey = periodKeyForChallenge(challenge, params.at)

  // Time window eligibility
  if (challenge.startsAt && params.at < challenge.startsAt) return null
  if (challenge.endsAt && params.at > challenge.endsAt) return null

  // Unique entity tracking
  let delta = params.delta
  if (challenge.metricSource === 'unique_entities' && params.uniqueSubject) {
    const seenKey = `challenge:${challenge.id}:${periodKey}:${params.appUserId}:${params.uniqueSubject}`
    const existing = await db.userVariable.findUnique({ where: { appUserId_key: { appUserId: params.appUserId, key: `uq.${seenKey}` } } })
    if (existing) {
      return null // already counted this subject
    }
    await db.userVariable.create({
      data: { appUserId: params.appUserId, key: `uq.${seenKey}`, valueJson: '"1"' },
    }).catch(() => null) // unique race tolerated
  }

  const existing = await db.challengeProgress.findUnique({
    where: { challengeId_appUserId_periodKey: { challengeId: challenge.id, appUserId: params.appUserId, periodKey } },
  })

  const progressBefore = existing?.progress ?? 0
  const alreadyCompleted = existing?.completed ?? false
  if (alreadyCompleted && challenge.repeatability === 'one_time') {
    return null
  }

  const progressAfter = Math.min(progressBefore + delta, challenge.target)
  const completed = progressAfter >= challenge.target
  const justCompleted = completed && !alreadyCompleted

  const record = await db.challengeProgress.upsert({
    where: { challengeId_appUserId_periodKey: { challengeId: challenge.id, appUserId: params.appUserId, periodKey } },
    create: {
      challengeId: challenge.id,
      appUserId: params.appUserId,
      progress: progressAfter,
      target: challenge.target,
      completed,
      completedAt: completed ? params.at : null,
      periodKey,
    },
    update: {
      progress: progressAfter,
      completed,
      completedAt: completed ? (existing?.completedAt ?? params.at) : null,
    },
  })
  void record

  let rewardsGranted: ActionDefinition[] = []
  if (justCompleted) {
    const rewardActions = parseJson<ActionDefinition[]>(challenge.rewardsJson, [])
    if (rewardActions.length > 0) {
      const results = await executeActions(rewardActions, {
        projectId: challenge.projectId,
        environmentId: challenge.environmentId,
        appUserId: params.appUserId,
        source: 'challenge',
        reference: challenge.id,
        correlationId: params.correlationId,
        causationId: params.eventId,
        idempotencyKey: `challenge:${challenge.id}:${params.appUserId}:${periodKey}:complete`,
      })
      rewardsGranted = rewardActions
      void results
    }
  }

  return {
    challenge: challenge.name,
    progressBefore,
    progressAfter,
    target: challenge.target,
    completed,
    justCompleted,
    rewardsGranted,
  }
}

/**
 * Direct event-driven progress update: find matching active challenges
 * for an event type and advance them.
 */
export async function processEventForChallenges(params: {
  projectId: string
  environmentId: string
  appUserId: string
  eventType: string
  payload: Record<string, unknown>
  subjectId: string | null
  at: Date
  correlationId?: string
  eventId?: string
}): Promise<ChallengeUpdateResult[]> {
  const challenges = await db.challenge.findMany({
    where: {
      projectId: params.projectId,
      environmentId: params.environmentId,
      eventType: params.eventType,
      status: 'active',
    },
  })

  const results: ChallengeUpdateResult[] = []
  for (const challenge of challenges) {
    const delta = eventProgressDelta(challenge, params.payload)
    if (delta === 0) continue
    const result = await updateChallengeProgress({
      challengeId: challenge.id,
      appUserId: params.appUserId,
      delta,
      at: params.at,
      correlationId: params.correlationId,
      eventId: params.eventId,
      uniqueSubject: params.subjectId,
    })
    if (result) results.push(result)
  }
  return results
}

export async function getUserChallenges(appUserId: string, projectId: string, environmentId: string, at: Date) {
  const challenges = await db.challenge.findMany({
    where: { projectId, environmentId, status: 'active' },
    orderBy: [{ type: 'asc' }, { createdAt: 'desc' }],
  })

  const results: Array<{
    id: string
    name: string
    description: string | null
    type: string
    target: number
    progress: number
    completed: boolean
    progressPercent: number
    endsAt: Date | null
  }> = []
  for (const c of challenges) {
    const periodKey = periodKeyForChallenge(c, at)
    const progress = await db.challengeProgress.findUnique({
      where: { challengeId_appUserId_periodKey: { challengeId: c.id, appUserId, periodKey } },
    })
    results.push({
      id: c.id,
      name: c.name,
      description: c.description,
      type: c.type,
      target: c.target,
      progress: progress?.progress ?? 0,
      completed: progress?.completed ?? false,
      progressPercent: c.target > 0 ? Math.min(100, Math.round(((progress?.progress ?? 0) / c.target) * 100)) : 0,
      endsAt: c.endsAt,
    })
  }
  return results
}

export async function claimChallengeReward(params: {
  challengeId: string
  appUserId: string
  periodKey?: string
  at: Date
}) {
  const challenge = await db.challenge.findUnique({ where: { id: params.challengeId } })
  if (!challenge) {
    throw new PlatformError({ code: 'CHALLENGE_NOT_FOUND', category: 'not_found', message: 'Challenge not found.' })
  }
  const periodKey = params.periodKey ?? periodKeyForChallenge(challenge, params.at)
  const progress = await db.challengeProgress.findUnique({
    where: { challengeId_appUserId_periodKey: { challengeId: params.challengeId, appUserId: params.appUserId, periodKey } },
  })
  if (!progress?.completed) {
    throw new PlatformError({ code: 'CHALLENGE_NOT_COMPLETED', category: 'conflict', message: 'This challenge is not completed yet.' })
  }
  if (progress.claimedAt) {
    throw new PlatformError({ code: 'ALREADY_CLAIMED', category: 'conflict', message: 'Reward already claimed for this period.' })
  }
  const rewardActions = parseJson<ActionDefinition[]>(challenge.rewardsJson, [])
  const results = await executeActions(rewardActions, {
    projectId: challenge.projectId,
    environmentId: challenge.environmentId,
    appUserId: params.appUserId,
    source: 'challenge_claim',
    reference: challenge.id,
    idempotencyKey: `claim:${challenge.id}:${params.appUserId}:${periodKey}`,
  })
  await db.challengeProgress.update({
    where: { id: progress.id },
    data: { claimedAt: params.at },
  })
  return results
}
