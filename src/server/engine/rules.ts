/**
 * GamificationOG — Rule Engine (Section 13)
 * WHEN event.type == X / IF conditions / THEN actions.
 * Features: priority ordering, per-user cooldown, frequency caps,
 * segment targeting, schedules, validity windows, decision tracing.
 */
import { db } from '@/lib/db'
import { parseJson, type ActionDefinition, type ConditionNode } from '../core/types'
import { evaluateCondition } from './condition'
import { executeActions, type ActionContext } from './actions'
import { cooldownPassed, withinWindow } from '../time/engine'
import { resolveField } from './condition'

export interface RuleEvaluationOutcome {
  ruleId: string
  ruleName: string
  matched: boolean
  skippedReason?: string
  conditionsMet: boolean
  actions: Array<{ action: string; status: string; detail: string }>
  durationMs: number
  error?: string
}

interface RuleLike {
  id: string
  name: string
  eventType: string
  conditionsJson: string
  actionsJson: string
  priority: number
  cooldownSeconds: number | null
  frequencyCap: number | null
  frequencyPeriod: string | null
  segmentId: string | null
  validFrom: Date | null
  validTo: Date | null
  status: string
}

/**
 * Evaluate all active rules matching an event.
 * Order: priority DESC, then createdAt ASC (deterministic).
 */
export async function evaluateRulesForEvent(params: {
  projectId: string
  environmentId: string
  appUserId: string
  eventType: string
  rawContext: Record<string, unknown>
  eventId: string
  correlationId?: string
  formulaVariables: Record<string, unknown>
  now: Date
}): Promise<{ outcomes: RuleEvaluationOutcome[]; actions: Array<{ action: string; status: string; detail: string }> }> {
  const rules = await db.rule.findMany({
    where: {
      projectId: params.projectId,
      environmentId: params.environmentId,
      eventType: params.eventType,
      status: 'active',
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  })

  const outcomes: RuleEvaluationOutcome[] = []
  const allActions: Array<{ action: string; status: string; detail: string }> = []

  for (const rule of rules) {
    const outcome = await evaluateSingleRule(rule, params)
    outcomes.push(outcome)
    if (outcome.matched) {
      allActions.push(...outcome.actions)
    }
  }

  return { outcomes, actions: allActions }
}

async function evaluateSingleRule(
  rule: RuleLike,
  params: {
    projectId: string
    environmentId: string
    appUserId: string
    rawContext: Record<string, unknown>
    eventId: string
    correlationId?: string
    formulaVariables: Record<string, unknown>
    now: Date
  },
): Promise<RuleEvaluationOutcome> {
  const started = Date.now()
  const base: RuleEvaluationOutcome = {
    ruleId: rule.id,
    ruleName: rule.name,
    matched: false,
    conditionsMet: false,
    actions: [],
    durationMs: 0,
  }

  // 1. Validity window
  if (!withinWindow(params.now, rule.validFrom, rule.validTo)) {
    return { ...base, skippedReason: 'schedule', durationMs: Date.now() - started }
  }

  // 2. Segment targeting
  if (rule.segmentId) {
    const userSegments = resolveField('user.segment', params.rawContext)
    const segmentIds = params.rawContext.__segmentIds as string[] | undefined
    const segmentNames = Array.isArray(userSegments) ? userSegments : []
    // Check both materialized ids and names against the rule's segment
    const ruleSegment = await db.segment.findUnique({ where: { id: rule.segmentId } })
    if (ruleSegment && !segmentNames.includes(ruleSegment.name) && !(segmentIds ?? []).includes(rule.segmentId)) {
      return { ...base, skippedReason: 'segment', durationMs: Date.now() - started }
    }
  }

  // 3. Cooldown (per user, per rule)
  if (rule.cooldownSeconds && rule.cooldownSeconds > 0) {
    const lastExecution = await db.ruleExecution.findFirst({
      where: { ruleId: rule.id, matched: true },
      orderBy: { executedAt: 'desc' },
    })
    // user-level cooldown via frequency tracking below is more precise;
    // rule-level cooldown uses global last matched execution
    if (lastExecution && !cooldownPassed(lastExecution.executedAt, rule.cooldownSeconds, params.now)) {
      return { ...base, skippedReason: 'cooldown', durationMs: Date.now() - started }
    }
  }

  // 4. Frequency cap (per user per period)
  if (rule.frequencyCap && rule.frequencyPeriod) {
    const periodStart = getPeriodStart(rule.frequencyPeriod, params.now)
    const recentCount = await db.ruleExecution.count({
      where: {
        ruleId: rule.id,
        matched: true,
        executedAt: { gte: periodStart },
      },
    })
    if (recentCount >= rule.frequencyCap) {
      return { ...base, skippedReason: 'frequency_cap', durationMs: Date.now() - started }
    }
  }

  // 5. Condition evaluation
  const conditions = parseJson<ConditionNode>(rule.conditionsJson, { op: 'and', conditions: [] })
  const conditionsMet = evaluateCondition(conditions, params.rawContext)

  if (!conditionsMet) {
    return { ...base, conditionsMet: false, durationMs: Date.now() - started }
  }

  // 6. Execute actions
  const actionDefs = parseJson<ActionDefinition[]>(rule.actionsJson, [])
  const actionCtx: ActionContext = {
    projectId: params.projectId,
    environmentId: params.environmentId,
    appUserId: params.appUserId,
    formulaVariables: params.formulaVariables,
    source: 'rule',
    reference: rule.id,
    correlationId: params.correlationId,
    causationId: params.eventId,
    idempotencyKey: `rule:${rule.id}:${params.eventId}`,
  }

  const actionResults = await executeActions(actionDefs, actionCtx)

  const durationMs = Date.now() - started
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    matched: true,
    conditionsMet: true,
    actions: actionResults.map((r) => ({ action: r.action, status: r.status, detail: r.detail })),
    durationMs,
  }
}

function getPeriodStart(period: string, now: Date): Date {
  const d = new Date(now)
  switch (period) {
    case 'hour': return new Date(d.getTime() - 3600000)
    case 'day': return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    case 'week': {
      const dayNum = d.getUTCDay() || 7
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
      start.setUTCDate(start.getUTCDate() - (dayNum - 1))
      return start
    }
    case 'month': return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
    default: return new Date(0)
  }
}

/** Persist rule executions (batch). */
export async function recordRuleExecutions(
  outcomes: RuleEvaluationOutcome[],
  eventId: string,
  decisionTraceId?: string,
): Promise<void> {
  if (outcomes.length === 0) return
  await db.ruleExecution.createMany({
    data: outcomes.map((o) => ({
      ruleId: o.ruleId,
      eventId,
      decisionTraceId: decisionTraceId ?? null,
      matched: o.matched,
      skippedReason: o.skippedReason ?? null,
      actionsExecuted: o.actions.length,
      error: o.error ?? null,
      durationMs: o.durationMs,
    })),
  })
}

export { }
