/**
 * GamificationOG — Action Engine (Section 15)
 * Actions are atomic, composable operations executed by the rule engine,
 * challenge completion, achievement unlocks, and streak milestones.
 * Every action: validation, idempotency (via action-level idempotency keys),
 * error classification, audit, decision trace integration.
 */
import { db } from '@/lib/db'
import type { ActionDefinition, ActionExecutionResult, EngineContext } from '../core/types'
import { evaluateFormula } from './formula'
import { PlatformError } from '../core/errors'
import { awardXp } from '../progression/service'
import { postLedgerTransaction } from '../economy/service'
import { grantItem } from '../inventory/service'
import { grantReward } from '../rewards/service'
import { unlockAchievement } from '../achievements/unlock'
import { updateChallengeProgress } from '../challenges/service'
import { updateLeaderboard } from '../leaderboards/service'
import { sendNotification } from '../notifications/service'
import { updateStreak } from '../streaks/service'
import { recordAudit } from '../audit/service'

export interface ActionContext {
  projectId: string
  environmentId: string
  appUserId: string
  engineContext?: EngineContext
  formulaVariables?: Record<string, unknown>
  source: string // rule | challenge | achievement | streak | admin | workflow
  reference?: string
  correlationId?: string
  causationId?: string
  idempotencyKey?: string
}

function actionKey(ctx: ActionContext, action: ActionDefinition, index: number): string | undefined {
  if (!ctx.idempotencyKey) return undefined
  return `${ctx.idempotencyKey}:action:${index}:${action.type}`
}

function resolveAmount(params: Record<string, unknown>, key: string, ctx: ActionContext): number {
  const raw = params[key]
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string' && raw.trim().length > 0) {
    // formula expression
    const value = evaluateFormula(raw, (ctx.formulaVariables ?? {}) as never)
    return value
  }
  throw new PlatformError({
    code: 'ACTION_INVALID_PARAM',
    category: 'engine',
    message: `Action parameter "${key}" must be a number or formula string.`,
  })
}

function requireString(params: Record<string, unknown>, key: string): string {
  const v = params[key]
  if (typeof v === 'string' && v.length > 0) return v
  throw new PlatformError({
    code: 'ACTION_INVALID_PARAM',
    category: 'engine',
    message: `Action parameter "${key}" is required (non-empty string).`,
  })
}

// ---------------------------------------------------------------------------
// The Action Registry — extensible via registerAction (Section 2.3)
// ---------------------------------------------------------------------------
export type ActionHandler = (
  params: Record<string, unknown>,
  ctx: ActionContext,
) => Promise<{ detail: string; before?: unknown; after?: unknown; skipped?: boolean }>

const actionRegistry = new Map<string, { handler: ActionHandler; description: string; domain: string }>()

function registerAction(type: string, domain: string, description: string, handler: ActionHandler) {
  actionRegistry.set(type, { handler, description, domain })
}

// award_xp — progression domain
registerAction('award_xp', 'progression', 'Award XP to a progression track', async (params, ctx) => {
  const amount = resolveAmount(params, 'amount', ctx)
  if (amount <= 0) return { detail: 'Skipped: non-positive XP', skipped: true }
  const result = await awardXp({
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
    appUserId: ctx.appUserId,
    trackCode: typeof params.track === 'string' ? params.track : 'default',
    amount: Math.round(amount),
    source: ctx.source,
    reference: ctx.reference,
    correlationId: ctx.correlationId,
    idempotencyKey: actionKey(ctx, { type: 'award_xp', params }, 0),
  })
  return {
    detail: `XP ${result.xpBefore} -> ${result.xpAfter} (track "${result.track}")${result.levelUp ? ` — LEVEL UP: ${result.levelBefore} -> ${result.levelAfter}` : ''}`,
    before: { xp: result.xpBefore, level: result.levelBefore },
    after: { xp: result.xpAfter, level: result.levelAfter },
  }
})

// add_currency — economy domain (ledger-first)
registerAction('add_currency', 'economy', 'Credit a currency via the ledger', async (params, ctx) => {
  const currencyCode = requireString(params, 'currency')
  const amount = resolveAmount(params, 'amount', ctx)
  if (amount <= 0) return { detail: 'Skipped: non-positive amount', skipped: true }
  const result = await postLedgerTransaction({
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
    appUserId: ctx.appUserId,
    currencyCode,
    amount,
    type: 'earn',
    reason: `Action: add_currency (${ctx.source})`,
    source: ctx.source,
    reference: ctx.reference,
    correlationId: ctx.correlationId,
    idempotencyKey: actionKey(ctx, { type: 'add_currency', params }, 0),
  })
  return {
    detail: `${amount > 0 ? '+' : ''}${amount} ${currencyCode} -> balance ${result.balanceAfter} [${result.status}]`,
    after: { balance: result.balanceAfter, status: result.status },
    skipped: result.status === 'duplicate',
  }
})

// spend_currency — economy domain
registerAction('spend_currency', 'economy', 'Debit a currency via the ledger', async (params, ctx) => {
  const currencyCode = requireString(params, 'currency')
  const amount = resolveAmount(params, 'amount', ctx)
  if (amount <= 0) return { detail: 'Skipped: non-positive amount', skipped: true }
  const result = await postLedgerTransaction({
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
    appUserId: ctx.appUserId,
    currencyCode,
    amount: -amount,
    type: 'spend',
    reason: `Action: spend_currency (${ctx.source})`,
    source: ctx.source,
    reference: ctx.reference,
    correlationId: ctx.correlationId,
    idempotencyKey: actionKey(ctx, { type: 'spend_currency', params }, 0),
  })
  return {
    detail: `-${amount} ${currencyCode} -> balance ${result.balanceAfter} [${result.status}]`,
    after: { balance: result.balanceAfter },
    skipped: result.status === 'duplicate',
  }
})

// grant_item — inventory domain
registerAction('grant_item', 'inventory', 'Grant an item to user inventory', async (params, ctx) => {
  const itemCode = requireString(params, 'item')
  const quantity = typeof params.quantity === 'number' ? params.quantity : 1
  const result = await grantItem({
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
    appUserId: ctx.appUserId,
    itemCode,
    quantity,
    correlationId: ctx.correlationId,
  })
  return {
    detail: `Granted ${result.quantityGranted}x ${itemCode} (total ${result.totalQuantity}) [${result.status}]`,
    after: { total: result.totalQuantity },
    skipped: result.status === 'duplicate',
  }
})

// grant_reward — composite reward resolution
registerAction('grant_reward', 'rewards', 'Resolve and grant a configured reward', async (params, ctx) => {
  const rewardCode = requireString(params, 'reward')
  const result = await grantReward({
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
    appUserId: ctx.appUserId,
    rewardCode,
    source: ctx.source,
    correlationId: ctx.correlationId,
    idempotencyKey: ctx.idempotencyKey ? `${ctx.idempotencyKey}:reward:${rewardCode}` : undefined,
  })
  return {
    detail: result.actions.map((a) => `${a.action}: ${a.detail}`).join('; ') || 'Reward had no effect',
    after: { status: result.status },
    skipped: result.status === 'skipped',
  }
})

// unlock_achievement — achievements domain
registerAction('unlock_achievement', 'achievements', 'Directly unlock an achievement', async (params, ctx) => {
  const codeOrId = requireString(params, 'achievement')
  const result = await unlockAchievement({
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
    appUserId: ctx.appUserId,
    code: codeOrId,
    correlationId: ctx.correlationId,
    idempotencyKey: ctx.idempotencyKey ? `${ctx.idempotencyKey}:ach:${codeOrId}` : undefined,
  })
  return {
    detail: result.justUnlocked ? `Achievement "${result.name}" unlocked` : `Already unlocked or not found`,
    skipped: !result.justUnlocked,
  }
})

// update_challenge_progress — challenge domain
registerAction('update_challenge_progress', 'challenges', 'Advance challenge progress by a delta', async (params, ctx) => {
  const challengeRef = requireString(params, 'challenge')
  const delta = typeof params.delta === 'number' ? params.delta : 1
  // resolve by id, then by code (packs and portable configs reference codes)
  let challengeId = challengeRef
  const byId = await db.challenge.findUnique({ where: { id: challengeRef }, select: { id: true } })
  if (!byId) {
    const byCode = await db.challenge.findFirst({
      where: { projectId: ctx.projectId, environmentId: ctx.environmentId, code: challengeRef },
      select: { id: true },
    })
    if (!byCode) return { detail: 'Challenge not found', skipped: true }
    challengeId = byCode.id
  }
  const result = await updateChallengeProgress({
    challengeId,
    appUserId: ctx.appUserId,
    delta,
    at: new Date(),
    correlationId: ctx.correlationId,
    eventId: ctx.causationId,
  })
  if (!result) return { detail: 'Challenge not found or not eligible', skipped: true }
  return {
    detail: `Progress ${result.progressBefore} -> ${result.progressAfter}/${result.target}${result.justCompleted ? ' — COMPLETED' : ''}`,
    after: { progress: result.progressAfter, completed: result.completed },
  }
})

// update_streak — streak domain
registerAction('update_streak', 'streaks', 'Mark a streak qualifying event', async (params, ctx) => {
  const streakRef = requireString(params, 'streak')
  // resolve by id, then by key (packs and portable configs reference keys)
  let streakId = streakRef
  const byId = await db.streak.findUnique({ where: { id: streakRef }, select: { id: true } })
  if (!byId) {
    const byKey = await db.streak.findFirst({
      where: { projectId: ctx.projectId, environmentId: ctx.environmentId, key: streakRef },
      select: { id: true },
    })
    if (!byKey) return { detail: 'Streak not found', skipped: true }
    streakId = byKey.id
  }
  const result = await updateStreak({
    streakId,
    appUserId: ctx.appUserId,
    at: new Date(),
    correlationId: ctx.correlationId,
    eventId: ctx.causationId,
  })
  if (!result) return { detail: 'Streak not found', skipped: true }
  return {
    detail: `Streak "${result.name}": ${result.evaluation} -> current ${result.current} (best ${result.best})${result.milestoneHit ? ` — MILESTONE ${result.milestoneHit}` : ''}`,
    after: { current: result.current, best: result.best },
  }
})

// update_leaderboard — ranking domain
registerAction('update_leaderboard', 'competition', 'Set or increment a leaderboard score', async (params, ctx) => {
  const leaderboardRef = requireString(params, 'leaderboard')
  const mode = params.mode === 'set' ? 'set' : 'increment'
  const score = resolveAmount(params, 'score', ctx)
  // resolve by id, then by code (packs and portable configs reference codes)
  let leaderboardId = leaderboardRef
  const byId = await db.leaderboard.findUnique({ where: { id: leaderboardRef }, select: { id: true } })
  if (!byId) {
    const byCode = await db.leaderboard.findFirst({
      where: { projectId: ctx.projectId, environmentId: ctx.environmentId, code: leaderboardRef },
      select: { id: true },
    })
    if (!byCode) return { detail: 'Leaderboard not found', skipped: true }
    leaderboardId = byCode.id
  }
  const result = await updateLeaderboard({
    leaderboardId,
    appUserId: ctx.appUserId,
    delta: score,
    at: new Date(),
    mode,
  })
  if (!result) return { detail: 'Leaderboard not found', skipped: true }
  return {
    detail: `Score ${result.score}, rank #${result.rank ?? '?'}${result.rankChanged ? ` (moved from #${result.rankBefore ?? '?'})` : ''}`,
    after: { score: result.score, rank: result.rank },
  }
})

// send_notification — notifications domain
registerAction('send_notification', 'notifications', 'Send a templated or direct notification', async (params, ctx) => {
  const title = typeof params.title === 'string' ? params.title : requireString(params, 'template')
  const result = await sendNotification({
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
    appUserId: ctx.appUserId,
    title,
    body: typeof params.body === 'string' ? params.body : undefined,
    type: typeof params.type === 'string' ? params.type : 'info',
    templateKey: typeof params.template === 'string' ? params.template : undefined,
    correlationId: ctx.correlationId,
  })
  return {
    detail: `"${result.title}" [${result.status}]`,
    after: { status: result.status, id: result.id },
    skipped: result.status !== 'sent',
  }
})

// grant_entitlement — monetization domain (§40): give a user an access right
registerAction('grant_entitlement', 'monetization', 'Grant an entitlement (access right) to a user', async (params, ctx) => {
  const code = requireString(params, 'code')
  const { grantEntitlement } = await import('../monetization/service')
  const durationDays = params.days === undefined || params.days === null ? null : Number(params.days)
  if (durationDays !== null && (!Number.isFinite(durationDays) || durationDays <= 0)) {
    throw new PlatformError({
      code: 'ACTION_INVALID_PARAM',
      category: 'engine',
      message: 'Entitlement "days" must be a positive number or omitted for permanent.',
    })
  }
  const res = await grantEntitlement({
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
    appUserId: ctx.appUserId,
    code,
    source: ctx.source === 'admin' ? 'grant' : ctx.source,
    sourceRef: ctx.reference,
    durationDays,
    metadata: { via: 'action', correlationId: ctx.correlationId ?? null },
  })
  return {
    detail: `entitlement "${code}" ${res.renewed ? 'renewed' : 'granted'}${res.entitlement.endsAt ? ` until ${res.entitlement.endsAt.toISOString().slice(0, 10)}` : ' (permanent)'}`,
    before: { granted: res.renewed },
    after: { code, status: res.entitlement.status, endsAt: res.entitlement.endsAt },
  }
})

// set_user_attribute — identity domain
registerAction('set_user_attribute', 'identity', 'Set a user profile attribute', async (params, ctx) => {
  const key = requireString(params, 'key')
  const value = params.value ?? null
  const user = await db.appUser.findUnique({ where: { id: ctx.appUserId } })
  if (!user) return { detail: 'User not found', skipped: true }
  const attributes = JSON.parse(user.attributesJson || '{}') as Record<string, unknown>
  const before = attributes[key]
  attributes[key] = value
  await db.appUser.update({
    where: { id: ctx.appUserId },
    data: { attributesJson: JSON.stringify(attributes) },
  })
  return {
    detail: `attribute.${key}: ${JSON.stringify(before)} -> ${JSON.stringify(value)}`,
    before: { [key]: before },
    after: { [key]: value },
  }
})

// set_user_variable — state domain
registerAction('set_user_variable', 'state', 'Set a user variable (custom state)', async (params, ctx) => {
  const key = requireString(params, 'key')
  const value = params.value ?? null
  await db.userVariable.upsert({
    where: { appUserId_key: { appUserId: ctx.appUserId, key } },
    create: { appUserId: ctx.appUserId, key, valueJson: JSON.stringify(value) },
    update: { valueJson: JSON.stringify(value) },
  })
  return { detail: `variable.${key} = ${JSON.stringify(value)}`, after: { [key]: value } }
})

// emit_event — re-enters the event gateway (internal causation chain)
registerAction('emit_event', 'events', 'Emit a derived event back into the gateway', async (params, ctx) => {
  const eventType = requireString(params, 'type')
  const { ingestEvent } = await import('../events/gateway')
  const result = await ingestEvent({
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
    request: {
      event_type: eventType,
      external_user_id: undefined, // gateway resolves from appUserId
      payload: (params.payload as Record<string, unknown>) ?? {},
      source: 'engine',
      correlation_id: ctx.correlationId ?? undefined,
      causation_id: ctx.causationId ?? undefined,
    },
    resolvedAppUserId: ctx.appUserId,
  })
  return {
    detail: `Derived event "${eventType}" -> ${result.status}`,
    after: { eventId: result.eventId, status: result.status },
  }
})

export function getActionRegistry() {
  return Array.from(actionRegistry.entries()).map(([type, meta]) => ({
    type,
    domain: meta.domain,
    description: meta.description,
  }))
}

export function validateActionDefinition(action: unknown): { valid: boolean; error?: string } {
  if (!action || typeof action !== 'object') return { valid: false, error: 'Action must be an object' }
  const a = action as Record<string, unknown>
  if (typeof a.type !== 'string' || !actionRegistry.has(a.type)) {
    return {
      valid: false,
      error: `Unknown action type "${a.type}". Available: ${Array.from(actionRegistry.keys()).join(', ')}`,
    }
  }
  if (a.params === undefined || a.params === null) return { valid: false, error: 'Action requires "params" object' }
  if (typeof a.params !== 'object') return { valid: false, error: '"params" must be an object' }
  return { valid: true }
}

/**
 * Execute a list of actions with per-action error isolation:
 * a failing action is recorded and does not abort the whole batch
 * (error classification per Section 15), while idempotency keys
 * protect external mutations (Invariant E).
 */
export async function executeActions(
  actions: ActionDefinition[],
  ctx: ActionContext,
): Promise<ActionExecutionResult[]> {
  const results: ActionExecutionResult[] = []

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]
    const registration = actionRegistry.get(action.type)
    if (!registration) {
      results.push({
        action: action.type,
        status: 'failed',
        detail: `Unknown action type "${action.type}"`,
      })
      continue
    }

    const actionIdempotencyKey = ctx.idempotencyKey ? `${ctx.idempotencyKey}:a${i}:${action.type}` : undefined

    try {
      const result = await registration.handler(action.params, {
        ...ctx,
        idempotencyKey: actionIdempotencyKey,
      })
      results.push({
        action: action.type,
        status: result.skipped ? 'skipped' : 'executed',
        detail: result.detail,
        before: result.before,
        after: result.after,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown action error'
      results.push({
        action: action.type,
        status: 'failed',
        detail: message,
      })
      await recordAudit({
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        actorType: 'system',
        action: 'action.failed',
        targetType: 'action',
        targetId: action.type,
        afterJson: JSON.stringify({ error: message, source: ctx.source, reference: ctx.reference }),
      }).catch(() => null)
    }
  }

  return results
}
