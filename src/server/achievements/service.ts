/**
 * GamificationOG — Achievement Service (Section 23)
 * One-time, repeatable, hidden/secret, progressive, compound, time-limited.
 * Triggered by the universal rule/condition engine evaluating achievement
 * conditions against the full engine context after each event.
 */
import { db } from '@/lib/db'
import { parseJson, type ActionDefinition, type ConditionNode } from '../core/types'
import { evaluateCondition } from '../engine/condition'
import { executeActions } from '../engine/actions'
import { resolveField } from '../engine/condition'

export interface AchievementUnlockResult {
  code: string
  name: string
  justUnlocked: boolean
  progress: number
  target: number
  alreadyUnlocked: boolean
  actions: ActionDefinition[]
}

/**
 * Evaluate all active achievements for a user against the given context.
 * Achievement conditions resolve against the same context fields as rules.
 * Progressive achievements track numeric progress via a "progress field".
 */
export async function evaluateAchievements(params: {
  projectId: string
  environmentId: string
  appUserId: string
  context: Record<string, unknown>
  correlationId?: string
  eventId?: string
}): Promise<AchievementUnlockResult[]> {
  const achievements = await db.achievement.findMany({
    where: { projectId: params.projectId, environmentId: params.environmentId, status: 'active' },
  })

  const results: AchievementUnlockResult[] = []

  for (const achievement of achievements) {
    const condition = parseJson<ConditionNode & { progressField?: string; progressTarget?: number }>(achievement.conditionsJson, { op: 'and', conditions: [] })

    const unlocked = await db.userAchievement.findUnique({
      where: { achievementId_appUserId: { achievementId: achievement.id, appUserId: params.appUserId } },
    })

    const isRepeatable = achievement.type === 'repeatable'
    if (unlocked?.unlockedAt && !isRepeatable) {
      // already unlocked, nothing to do (still track progress for progressive display)
      continue
    }

    // Progressive: track numeric progress toward target
    let progressValue = 1
    let targetValue = 1
    if (condition.progressField) {
      const raw = resolveField(condition.progressField, params.context)
      progressValue = typeof raw === 'number' ? raw : Number(raw) || 0
      targetValue = condition.progressTarget ?? 1
    }

    const conditionMet = evaluateCondition(
      condition.progressField
        ? { field: condition.progressField, operator: 'gte', value: targetValue }
        : condition,
      params.context,
    )

    const nowUnlocked = conditionMet || (condition.progressField !== undefined && progressValue >= targetValue)

    const record = await db.userAchievement.upsert({
      where: { achievementId_appUserId: { achievementId: achievement.id, appUserId: params.appUserId } },
      create: {
        achievementId: achievement.id,
        appUserId: params.appUserId,
        progress: condition.progressField ? progressValue : (nowUnlocked ? 1 : 0),
        target: targetValue,
        unlockedAt: nowUnlocked ? new Date() : null,
      },
      update: {
        progress: condition.progressField ? progressValue : (nowUnlocked ? 1 : record0(unlocked?.progress)),
        target: targetValue,
        ...(nowUnlocked && !unlocked?.unlockedAt ? { unlockedAt: new Date() } : {}),
      },
    })
    void record

    const justUnlocked = nowUnlocked && !unlocked?.unlockedAt

    let actions: ActionDefinition[] = []
    if (justUnlocked) {
      const rewardActions = parseJson<ActionDefinition[]>(achievement.rewardsJson, [])
      if (rewardActions.length > 0) {
        await executeActions(rewardActions, {
          projectId: params.projectId,
          environmentId: params.environmentId,
          appUserId: params.appUserId,
          source: 'achievement',
          reference: achievement.id,
          correlationId: params.correlationId,
          causationId: params.eventId,
          idempotencyKey: `achievement:${achievement.id}:${params.appUserId}:unlock`,
        })
        actions = rewardActions
      }
    }

    results.push({
      code: achievement.code,
      name: achievement.name,
      justUnlocked,
      progress: condition.progressField ? progressValue : (record?.unlockedAt ? 1 : 0),
      target: targetValue,
      alreadyUnlocked: Boolean(unlocked?.unlockedAt),
      actions,
    })
  }

  return results
}

function record0(p: number | undefined): number {
  return p ?? 0
}

export async function getUserAchievements(appUserId: string, projectId: string, environmentId: string) {
  const achievements = await db.achievement.findMany({
    where: { projectId, environmentId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  })
  const unlocked = await db.userAchievement.findMany({ where: { appUserId } })
  const unlockedMap = new Map(unlocked.map((u) => [u.achievementId, u]))

  return achievements.map((a) => {
    const u = unlockedMap.get(a.id)
    const isUnlocked = Boolean(u?.unlockedAt)
    return {
      id: a.id,
      code: a.code,
      name: a.name,
      description: a.description,
      category: a.category,
      type: a.type,
      icon: a.icon,
      points: a.points,
      hidden: a.hidden && !isUnlocked,
      unlocked: isUnlocked,
      unlockedAt: u?.unlockedAt ?? null,
      progress: u?.progress ?? 0,
      target: u?.target ?? 1,
      progressPercent: u && u.target > 0 ? Math.min(100, Math.round((u.progress / u.target) * 100)) : (isUnlocked ? 100 : 0),
    }
  })
}
