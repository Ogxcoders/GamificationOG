/**
 * GamificationOG — Reward Service (Section 26)
 * Rewards are abstract outcomes: xp, points, currency, item, entitlement,
 * badge, discount, custom. Granting composes underlying engines
 * (progression / economy / inventory) and records audit.
 */
import { db } from '@/lib/db'
import { parseJson, type ActionExecutionResult } from '../core/types'
import { PlatformError } from '../core/errors'
import { awardXp } from '../progression/service'
import { postLedgerTransaction } from '../economy/service'
import { grantItem } from '../inventory/service'

export interface RewardConfig {
  xpAmount?: number
  trackCode?: string
  currencyCode?: string
  amount?: number
  itemCode?: string
  quantity?: number
  entitlementKey?: string
}

export interface RewardGrantOutcome {
  reward: string
  status: 'granted' | 'skipped' | 'failed'
  actions: ActionExecutionResult[]
}

/**
 * Resolve a Reward definition into concrete grants against the underlying
 * engines. Each reward type dispatches to its owning domain (Section 172:
 * Domain Ownership Rule).
 */
export async function grantReward(params: {
  projectId: string
  environmentId: string
  appUserId: string
  rewardCode: string
  source?: string
  correlationId?: string
  causationId?: string
  idempotencyKey?: string
}): Promise<RewardGrantOutcome> {
  const reward = await db.reward.findUnique({
    where: {
      projectId_environmentId_code: {
        projectId: params.projectId,
        environmentId: params.environmentId,
        code: params.rewardCode,
      },
    },
  })

  if (!reward) {
    throw new PlatformError({
      code: 'REWARD_NOT_FOUND',
      category: 'economy',
      message: `Reward "${params.rewardCode}" does not exist in this environment.`,
      fix: `Create reward "${params.rewardCode}" in the Rewards section.`,
    })
  }

  const config = parseJson<RewardConfig>(reward.configJson, {})
  const actions: ActionExecutionResult[] = []

  if (reward.type === 'xp' && config.xpAmount) {
    const result = await awardXp({
      projectId: params.projectId,
      environmentId: params.environmentId,
      appUserId: params.appUserId,
      trackCode: config.trackCode ?? 'default',
      amount: config.xpAmount,
      source: 'reward',
      reference: reward.id,
      correlationId: params.correlationId,
      idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:xp` : undefined,
    })
    actions.push({
      action: `award_xp(${result.xpAwarded})`,
      status: 'executed',
      detail: `XP ${result.xpBefore} -> ${result.xpAfter} on track "${result.track}"${result.levelUp ? `, LEVEL UP ${result.levelBefore} -> ${result.levelAfter}` : ''}`,
      before: { xp: result.xpBefore, level: result.levelBefore },
      after: { xp: result.xpAfter, level: result.levelAfter },
    })
  }

  if (reward.type === 'currency' && config.currencyCode && config.amount) {
    const result = await postLedgerTransaction({
      projectId: params.projectId,
      environmentId: params.environmentId,
      appUserId: params.appUserId,
      currencyCode: config.currencyCode,
      amount: Math.abs(config.amount),
      type: 'earn',
      reason: `Reward: ${reward.name}`,
      source: 'reward',
      reference: reward.id,
      correlationId: params.correlationId,
      idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:currency` : undefined,
    })
    actions.push({
      action: `add_currency(${config.currencyCode}, ${config.amount})`,
      status: result.status === 'duplicate' ? 'skipped' : 'executed',
      detail: `Balance after: ${result.balanceAfter} ${config.currencyCode}`,
      after: { balance: result.balanceAfter },
    })
  }

  if (reward.type === 'item' && config.itemCode) {
    const result = await grantItem({
      projectId: params.projectId,
      environmentId: params.environmentId,
      appUserId: params.appUserId,
      itemCode: config.itemCode,
      quantity: config.quantity ?? 1,
      correlationId: params.correlationId,
    })
    actions.push({
      action: `grant_item(${config.itemCode}, ${result.quantityGranted})`,
      status: result.status === 'duplicate' ? 'skipped' : 'executed',
      detail: `Total owned: ${result.totalQuantity}`,
      after: { totalQuantity: result.totalQuantity },
    })
  }

  if (reward.type === 'points') {
    // Points are tracked as user variables — lightweight score system
    const varKey = `points.${reward.code}`
    const existing = await db.userVariable.findUnique({
      where: { appUserId_key: { appUserId: params.appUserId, key: varKey } },
    })
    const before = existing ? parseJson<number>(existing.valueJson, 0) : 0
    const after = before + (config.amount ?? 10)
    await db.userVariable.upsert({
      where: { appUserId_key: { appUserId: params.appUserId, key: varKey } },
      create: { appUserId: params.appUserId, key: varKey, valueJson: JSON.stringify(after) },
      update: { valueJson: JSON.stringify(after) },
    })
    actions.push({
      action: `grant_points(${config.amount ?? 10})`,
      status: 'executed',
      detail: `Points "${reward.code}": ${before} -> ${after}`,
      before, after,
    })
  }

  if (reward.type === 'entitlement' && config.entitlementKey) {
    // Entitlements modeled as long-lived user variables (readable by clients)
    const varKey = `entitlement.${config.entitlementKey}`
    const grantedAt = new Date().toISOString()
    await db.userVariable.upsert({
      where: { appUserId_key: { appUserId: params.appUserId, key: varKey } },
      create: { appUserId: params.appUserId, key: varKey, valueJson: JSON.stringify({ granted: true, grantedAt, reward: reward.code }) },
      update: { valueJson: JSON.stringify({ granted: true, grantedAt, reward: reward.code }) },
    })
    actions.push({
      action: `grant_entitlement(${config.entitlementKey})`,
      status: 'executed',
      detail: `Entitlement "${config.entitlementKey}" activated`,
    })
  }

  if (reward.type === 'badge') {
    const varKey = `badge.${reward.code}`
    const existing = await db.userVariable.findUnique({
      where: { appUserId_key: { appUserId: params.appUserId, key: varKey } },
    })
    if (!existing) {
      await db.userVariable.create({
        data: { appUserId: params.appUserId, key: varKey, valueJson: JSON.stringify({ grantedAt: new Date().toISOString() }) },
      })
      actions.push({ action: `grant_badge(${reward.code})`, status: 'executed', detail: `Badge "${reward.name}" granted` })
    } else {
      actions.push({ action: `grant_badge(${reward.code})`, status: 'skipped', detail: 'Badge already owned' })
    }
  }

  return {
    reward: reward.code,
    status: actions.some((a) => a.status === 'executed') ? 'granted' : 'skipped',
    actions,
  }
}
