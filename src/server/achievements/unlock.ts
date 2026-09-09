/**
 * GamificationOG — Direct Achievement Unlock
 * Supports unlock by code (admin/sim flows) with idempotency.
 */
import { db } from '@/lib/db'
import { parseJson, type ActionDefinition } from '../core/types'
import { executeActions } from '../engine/actions'

export async function unlockAchievement(params: {
  projectId: string
  environmentId: string
  appUserId: string
  code: string
  correlationId?: string
  idempotencyKey?: string
}): Promise<{ code: string; name: string; justUnlocked: boolean }> {
  const achievement = await db.achievement.findFirst({
    where: {
      projectId: params.projectId,
      environmentId: params.environmentId,
      OR: [{ code: params.code }, { id: params.code }],
    },
  })

  if (!achievement) {
    return { code: params.code, name: params.code, justUnlocked: false }
  }

  const existing = await db.userAchievement.findUnique({
    where: { achievementId_appUserId: { achievementId: achievement.id, appUserId: params.appUserId } },
  })

  const alreadyUnlocked = Boolean(existing?.unlockedAt)

  if (!existing) {
    await db.userAchievement.create({
      data: {
        achievementId: achievement.id,
        appUserId: params.appUserId,
        progress: 1,
        target: 1,
        unlockedAt: new Date(),
      },
    })
  } else if (!alreadyUnlocked) {
    await db.userAchievement.update({
      where: { id: existing.id },
      data: { progress: 1, unlockedAt: new Date() },
    })
  }

  const justUnlocked = !alreadyUnlocked

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
        idempotencyKey: params.idempotencyKey,
      })
    }
  }

  return { code: achievement.code, name: achievement.name, justUnlocked }
}
