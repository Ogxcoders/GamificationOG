/**
 * GamificationOG — Event Gateway + Processing Pipeline (Sections 10, 11, 4)
 * The universal feedback loop:
 *   EVENT -> CONTEXT -> CONDITION -> DECISION -> ACTION -> STATE CHANGE -> EVENT
 * Flow: authenticate (done by caller) -> schema validation -> idempotency
 *   -> persist -> build context -> evaluate rules -> execute actions
 *   -> advance processors (challenges, streaks, leaderboards, achievements)
 *   -> XP sync -> decision trace -> analytics -> notifications.
 */
import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import {
  parseJson,
  type EventProcessingResult,
  type TraceStep,
  type EventIngestionRequest,
  type ActionDefinition,
} from '../core/types'
import { PlatformError, newTraceId } from '../core/errors'
import { buildEngineContext } from '../engine/context'
import { evaluateRulesForEvent, recordRuleExecutions } from '../engine/rules'
import { processEventForChallenges } from '../challenges/service'
import { processEventForStreaks } from '../streaks/service'
import { processEventForLeaderboards } from '../leaderboards/service'
import { syncXpLeaderboards } from '../leaderboards/service'
import { evaluateAchievements } from '../achievements/service'
import { awardXp } from '../progression/service'
import { recordAudit } from '../audit/service'
import { bumpDailyMetrics } from '../analytics/service'

// ---------------------------------------------------------------------------
// Schema validation (Section 10 — Schema Registry)
// ---------------------------------------------------------------------------

interface PropertySpec {
  type?: 'string' | 'number' | 'boolean' | 'integer' | 'array' | 'object'
  required?: boolean
  min?: number
  max?: number
  enum?: Array<string | number>
  description?: string
}

export function validateEventPayload(
  schemaSpec: Record<string, PropertySpec>,
  payload: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  for (const [prop, spec] of Object.entries(schemaSpec)) {
    const value = payload[prop]
    if (value === undefined || value === null) {
      if (spec.required) errors.push(`Missing required property "${prop}"`)
      continue
    }
    if (spec.type) {
      const typeOk =
        spec.type === 'string' ? typeof value === 'string'
        : spec.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : spec.type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
        : spec.type === 'boolean' ? typeof value === 'boolean'
        : spec.type === 'array' ? Array.isArray(value)
        : spec.type === 'object' ? typeof value === 'object' && !Array.isArray(value)
        : true
      if (!typeOk) {
        errors.push(`Property "${prop}" must be of type ${spec.type}`)
        continue
      }
    }
    if (spec.min !== undefined && typeof value === 'number' && value < spec.min) {
      errors.push(`Property "${prop}" must be >= ${spec.min}`)
    }
    if (spec.max !== undefined && typeof value === 'number' && value > spec.max) {
      errors.push(`Property "${prop}" must be <= ${spec.max}`)
    }
    if (spec.enum && !spec.enum.includes(value as string | number)) {
      errors.push(`Property "${prop}" must be one of: ${spec.enum.join(', ')}`)
    }
  }
  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export interface IngestParams {
  projectId: string
  environmentId: string
  request: EventIngestionRequest
  resolvedAppUserId?: string // internal flows (emit_event) already resolved the user
}

export async function ingestEvent(params: IngestParams): Promise<EventProcessingResult> {
  const { projectId, environmentId, request } = params
  const emptyDelta = () => ({
    xpAwarded: 0,
    levelUps: [] as EventProcessingResult['stateDelta']['levelUps'],
    currencyChanges: [] as EventProcessingResult['stateDelta']['currencyChanges'],
    itemsGranted: [] as EventProcessingResult['stateDelta']['itemsGranted'],
    achievementsUnlocked: [] as EventProcessingResult['stateDelta']['achievementsUnlocked'],
    challengesCompleted: [] as EventProcessingResult['stateDelta']['challengesCompleted'],
    streak: null as EventProcessingResult['stateDelta']['streak'],
    leaderboardUpdates: [] as EventProcessingResult['stateDelta']['leaderboardUpdates'],
    notifications: 0,
  })

  // ---- validation ----
  if (!request.event_type || typeof request.event_type !== 'string') {
    throw new PlatformError({
      code: 'EVENT_TYPE_REQUIRED',
      category: 'validation',
      message: 'Field "event_type" is required and must be a string.',
      fix: 'Send e.g. { "event_type": "task.completed", "payload": {} }',
    })
  }
  if (request.event_type.length > 120) {
    throw new PlatformError({
      code: 'EVENT_TYPE_TOO_LONG',
      category: 'validation',
      message: `"event_type" exceeds 120 characters.`,
    })
  }
  if (request.payload && typeof request.payload !== 'object') {
    throw new PlatformError({
      code: 'PAYLOAD_INVALID',
      category: 'validation',
      message: '"payload" must be an object.',
    })
  }

  // ---- resolve actor ----
  let appUserId = params.resolvedAppUserId ?? null
  if (!appUserId && request.external_user_id) {
    const user = await db.appUser.findUnique({
      where: {
        projectId_environmentId_externalId: {
          projectId,
          environmentId,
          externalId: request.external_user_id,
        },
      },
    })
    appUserId = user?.id ?? null
  }

  const occurredAt = parseDate(request.occurred_at) ?? new Date()
  const eventId = randomUUID()
  const correlationId = request.correlation_id ?? newTraceId()

  // ---- schema validation ----
  const schema = await db.eventSchema.findFirst({
    where: { projectId, name: request.event_type, status: 'active' },
    orderBy: { version: 'desc' },
  })
  if (schema) {
    const spec = parseJson<Record<string, PropertySpec>>(schema.payloadSchemaJson, {})
    if (Object.keys(spec).length > 0) {
      const result = validateEventPayload(spec, request.payload ?? {})
      if (!result.valid) {
        throw new PlatformError({
          code: 'SCHEMA_VALIDATION_FAILED',
          category: 'validation',
          message: `Event "${request.event_type}" failed schema validation.`,
          detail: result.errors.join('; '),
          fix: `Check the payload against schema "${request.event_type}" v${schema.version} in the Events section.`,
        })
      }
    }
  }

  // ---- idempotency + persistence ----
  const idempotencyKey = request.idempotency_key ?? null
  if (idempotencyKey) {
    const existing = await db.event.findUnique({
      where: {
        projectId_environmentId_idempotencyKey: {
          projectId,
          environmentId: environmentId,
          idempotencyKey,
        },
      },
    })
    if (existing && existing.status === 'processed') {
      return {
        eventId: existing.eventId,
        status: 'duplicate',
        traceId: undefined,
        actions: [],
        stateDelta: emptyDelta(),
      }
    }
  }

  const event = await db.event.create({
    data: {
      eventId,
      eventType: request.event_type,
      eventVersion: request.event_version ?? schema?.version ?? 1,
      projectId,
      environmentId,
      actorId: appUserId,
      subjectId: request.subject_id ?? null,
      source: request.source ?? 'api',
      occurredAt,
      correlationId,
      causationId: request.causation_id ?? null,
      idempotencyKey,
      payloadJson: JSON.stringify(request.payload ?? {}),
      metadataJson: JSON.stringify(request.metadata ?? {}),
      status: 'processing',
    },
  })

  if (!appUserId) {
    // Anonymous tracking without a resolved user: event is recorded but not processed
    await db.event.update({
      where: { id: event.id },
      data: { status: 'skipped', processingError: 'No user resolved for event' },
    })
    return {
      eventId,
      status: 'skipped',
      error: 'No user resolved. Call identify() first or pass external_user_id.',
      actions: [],
      stateDelta: emptyDelta(),
    }
  }

  // ---- processing ----
  const result = await processEvent({
    eventRowId: event.id,
    eventId,
    eventType: request.event_type,
    eventVersion: event.eventVersion,
    projectId,
    environmentId,
    appUserId,
    subjectId: request.subject_id ?? null,
    source: event.source,
    occurredAt,
    correlationId,
    payload: request.payload ?? {},
  })

  await bumpDailyMetrics(projectId, environmentId, occurredAt, [
    { metricType: 'events_ingested', dimension: request.event_type, value: 1 },
  ])

  return result
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

// ---------------------------------------------------------------------------
// The core pipeline
// ---------------------------------------------------------------------------

export async function processEvent(params: {
  eventRowId: string
  eventId: string
  eventType: string
  eventVersion: number
  projectId: string
  environmentId: string
  appUserId: string
  subjectId: string | null
  source: string
  occurredAt: Date
  correlationId: string
  payload: Record<string, unknown>
}): Promise<EventProcessingResult> {
  const steps: TraceStep[] = []
  let stepCount = 0
  const pipelineStart = Date.now()

  const delta: EventProcessingResult['stateDelta'] = {
    xpAwarded: 0,
    levelUps: [],
    currencyChanges: [],
    itemsGranted: [],
    achievementsUnlocked: [],
    challengesCompleted: [],
    streak: null,
    leaderboardUpdates: [],
    notifications: 0,
  }
  const actionResults: EventProcessingResult['actions'] = []

  const step = async (name: string, fn: () => Promise<string>) => {
    const t0 = Date.now()
    const detail = await fn()
    steps.push({ step: ++stepCount, name, detail, durationMs: Date.now() - t0 })
  }

  // 1. Build context
  let rawContext: Record<string, unknown> = {}
  await step('build_context', async () => {
    const built = await buildEngineContext({
      projectId: params.projectId,
      environmentId: params.environmentId,
      appUserId: params.appUserId,
      event: {
        id: params.eventId,
        type: params.eventType,
        version: params.eventVersion,
        payload: params.payload,
        occurredAt: params.occurredAt,
        source: params.source,
      },
    })
    rawContext = built.raw
    // stash segment ids for rule segment checks
    rawContext.__segmentIds = (built.context.segments as { ids: string[] }).ids
    const segs = (built.context.segments as { names: string[] }).names
    return `user=${built.context.user.externalId} level=${built.context.progression.tracks[0]?.level ?? 1} segments=[${segs.join(', ')}] flags=${Object.keys(built.context.flags).length}`
  })

  // formula variables mirror the raw context
  const formulaVariables = flattenForFormula(rawContext)

  // 2. Rule evaluation
  let ruleOutcomes: Awaited<ReturnType<typeof evaluateRulesForEvent>>['outcomes'] = []
  await step('evaluate_rules', async () => {
    const { outcomes } = await evaluateRulesForEvent({
      projectId: params.projectId,
      environmentId: params.environmentId,
      appUserId: params.appUserId,
      eventType: params.eventType,
      rawContext,
      eventId: params.eventId,
      correlationId: params.correlationId,
      formulaVariables,
      now: params.occurredAt,
    })
    ruleOutcomes = outcomes
    const matched = outcomes.filter((o) => o.matched)
    const skipped = outcomes.filter((o) => o.skippedReason)
    const failedConditions = outcomes.filter((o) => !o.matched && !o.skippedReason)
    return `matched=${matched.length} skipped=${skipped.length} not_met=${failedConditions.length}`
  })

  // collect rule actions into results
  for (const outcome of ruleOutcomes) {
    if (outcome.matched) {
      actionResults.push(...outcome.actions.map((a) => ({
        action: `[${outcome.ruleName}] ${a.action}`,
        status: a.status as 'executed' | 'skipped' | 'failed',
        detail: a.detail,
      })))
    }
  }

  // 3. Challenge processors
  await step('process_challenges', async () => {
    const results = await processEventForChallenges({
      projectId: params.projectId,
      environmentId: params.environmentId,
      appUserId: params.appUserId,
      eventType: params.eventType,
      payload: params.payload,
      subjectId: params.subjectId,
      at: params.occurredAt,
      correlationId: params.correlationId,
      eventId: params.eventId,
    })
    for (const r of results) {
      if (r.justCompleted) {
        delta.challengesCompleted.push({ name: r.challenge })
      }
    }
    return results.length > 0
      ? results.map((r) => `${r.challenge}: ${r.progressAfter}/${r.target}${r.justCompleted ? ' ✓' : ''}`).join('; ')
      : 'no matching challenges'
  })

  // 4. Streak processors
  await step('process_streaks', async () => {
    const results = await processEventForStreaks({
      projectId: params.projectId,
      environmentId: params.environmentId,
      appUserId: params.appUserId,
      eventType: params.eventType,
      at: params.occurredAt,
      correlationId: params.correlationId,
      eventId: params.eventId,
    })
    if (results.length > 0) {
      const main = results[0]
      delta.streak = { key: main.key, current: main.current, best: main.best }
    }
    return results.length > 0
      ? results.map((r) => `${r.name}: ${r.evaluation} -> ${r.current}`).join('; ')
      : 'no matching streaks'
  })

  // 5. Leaderboard processors
  await step('process_leaderboards', async () => {
    const results = await processEventForLeaderboards({
      projectId: params.projectId,
      environmentId: params.environmentId,
      appUserId: params.appUserId,
      eventType: params.eventType,
      payload: params.payload,
      at: params.occurredAt,
    })
    for (const r of results) {
      delta.leaderboardUpdates.push({ leaderboard: r.leaderboard, score: r.score, rank: r.rank })
    }
    return results.length > 0
      ? results.map((r) => `${r.leaderboard}: score=${r.score} rank=#${r.rank ?? '?'}`).join('; ')
      : 'no matching leaderboards'
  })

  // 6. Achievement evaluation (post-state-change, sees updated context)
  await step('evaluate_achievements', async () => {
    // rebuild context to include state changes from rule actions
    const rebuilt = await buildEngineContext({
      projectId: params.projectId,
      environmentId: params.environmentId,
      appUserId: params.appUserId,
      event: {
        id: params.eventId,
        type: params.eventType,
        version: params.eventVersion,
        payload: params.payload,
        occurredAt: params.occurredAt,
        source: params.source,
      },
    })
    const results = await evaluateAchievements({
      projectId: params.projectId,
      environmentId: params.environmentId,
      appUserId: params.appUserId,
      context: rebuilt.raw,
      correlationId: params.correlationId,
      eventId: params.eventId,
    })
    for (const r of results) {
      if (r.justUnlocked && !r.alreadyUnlocked) {
        delta.achievementsUnlocked.push({ code: r.code, name: r.name })
        actionResults.push({
          action: `unlock_achievement(${r.code})`,
          status: 'executed',
          detail: `Achievement "${r.name}" unlocked`,
        })
      }
    }
    const unlocked = results.filter((r) => r.justUnlocked)
    return unlocked.length > 0
      ? `unlocked: ${unlocked.map((r) => r.name).join(', ')}`
      : `evaluated=${results.length}, no new unlocks`
  })

  // 7. XP leaderboards sync
  await step('sync_xp_leaderboards', async () => {
    const progression = await db.userProgression.findFirst({
      where: { appUserId: params.appUserId, track: { code: 'default' } },
    })
    if (!progression) return 'no xp to sync'
    const results = await syncXpLeaderboards({
      projectId: params.projectId,
      environmentId: params.environmentId,
      appUserId: params.appUserId,
      xp: progression.xp,
      at: params.occurredAt,
    })
    return results.length > 0 ? results.map((r) => `${r.leaderboard}: xp=${r.score}`).join('; ') : 'no xp leaderboards'
  })

  // Derive state delta summary from action results (scan details)
  summarizeActions(actionResults, delta)

  // 8. Record trace + finalize
  const traceId = randomUUID()
  const totalDuration = Date.now() - pipelineStart

  await db.decisionTrace.create({
    data: {
      projectId: params.projectId,
      environmentId: params.environmentId,
      eventId: params.eventRowId,
      correlationId: params.correlationId,
      appUserId: params.appUserId,
      eventType: params.eventType,
      source: params.source,
      stepsJson: JSON.stringify(steps),
      summary: `Matched ${ruleOutcomes.filter((o) => o.matched).length} rules, executed ${actionResults.filter((a) => a.status === 'executed').length} actions`,
      actionsCount: actionResults.filter((a) => a.status === 'executed').length,
      durationMs: totalDuration,
    },
  })

  await recordRuleExecutions(
    ruleOutcomes.map((o) => ({ ...o, actions: o.actions.map((a) => ({ action: a.action, status: a.status, detail: a.detail })) })),
    params.eventRowId,
    traceId,
  )

  await db.event.update({
    where: { id: params.eventRowId },
    data: { status: 'processed' },
  })

  await bumpDailyMetrics(params.projectId, params.environmentId, params.occurredAt, [
    { metricType: 'events_processed', dimension: params.eventType, value: 1 },
    { metricType: 'actions_executed', dimension: '', value: actionResults.filter((a) => a.status === 'executed').length },
  ])

  return {
    eventId: params.eventId,
    status: 'processed',
    traceId,
    actions: actionResults,
    stateDelta: delta,
  }
}

function summarizeActions(actions: EventProcessingResult['actions'], delta: EventProcessingResult['stateDelta']) {
  for (const a of actions) {
    if (a.action.includes('award_xp') && a.status === 'executed') {
      const m = a.detail.match(/XP (\d+) -> (\d+)/)
      if (m) delta.xpAwarded += Number(m[2]) - Number(m[1])
      const lu = a.detail.match(/LEVEL UP: (\d+) -> (\d+)/)
      if (lu) delta.levelUps.push({ track: 'default', from: Number(lu[1]), to: Number(lu[2]) })
    }
    if ((a.action.includes('add_currency') || a.action.includes('spend_currency')) && a.status === 'executed') {
      const m = a.detail.match(/(-?\+?\d+) (\w+) -> balance (-?\d+)/)
      if (m) delta.currencyChanges.push({ currency: m[2], amount: Number(m[1]), balanceAfter: Number(m[3]) })
    }
    if (a.action.includes('grant_item') && a.status === 'executed') {
      const m = a.action.match(/grant_item\((\w+),\s*(\d+)\)/)
      if (m) delta.itemsGranted.push({ item: m[1], quantity: Number(m[2]) })
    }
  }
}

/**
 * Flatten context into formula-friendly variables:
 *   user.level, event.payload.<prop>, project.name, time.hour_of_day ...
 */
function flattenForFormula(raw: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = {}
  const walk = (obj: Record<string, unknown>, prefix: string, depth: number) => {
    if (depth > 3) return
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('__')) continue
      const path = prefix ? `${prefix}.${k}` : k
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, path, depth + 1)
      } else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        flat[path] = v
      }
    }
  }
  walk(raw, '', 0)
  return flat
}

export type { ActionDefinition }
