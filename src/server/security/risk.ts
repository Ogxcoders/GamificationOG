/**
 * GamificationOG — Universal Risk Engine (§74 Fraud / Abuse / Anti-Cheat)
 *
 *   Event → Risk Analysis → Risk Score → Allow | Throttle | Hold | Reject
 *
 * Detection signals (each contributes points to a 0–100 score):
 *   - VELOCITY_MINUTE / VELOCITY_HOUR  — event bursts per user (bots, farming)
 *   - IMPOSSIBLE_SPEED                 — events arriving faster than humanly
 *                                       possible (server-authoritative clock)
 *   - DUPLICATE_PAYLOAD                — identical type+payload repetition
 *                                       (reward farming, scripted replay)
 *   - VALUE_ANOMALY                    — numeric payload outliers vs the recent
 *                                       population for that event type
 *                                       (leaderboard manipulation, fake events)
 *   - MULTI_ACCOUNT                    — one subject (device/referral target)
 *                                       driven by several actors in a window
 *
 * Decision semantics:
 *   allow    — process normally (no flag)
 *   throttle — process, but open a reviewable flag and surface `risk` to the
 *              caller so SDKs can back off
 *   hold     — persist, do NOT process; admin must release or reject
 *   reject   — persist, do NOT process; fraudulent by score
 *
 * The engine fails OPEN: any internal error lets the event through untouched,
 * and environments without a RiskConfig row are not analyzed at all (default
 * off — opt-in per project+environment).
 */
import { db } from '@/lib/db'
import { parseJson } from '../core/types'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RiskConfigValues {
  enabled: boolean
  maxEventsPerMinute: number
  maxEventsPerHour: number
  minEventIntervalMs: number
  maxDuplicatePayloads: number
  duplicateWindowMinutes: number
  maxValueStddevs: number
  thresholdThrottle: number
  thresholdHold: number
  thresholdReject: number
}

export const DEFAULT_RISK_CONFIG: RiskConfigValues = {
  enabled: true,
  maxEventsPerMinute: 240,
  maxEventsPerHour: 2000,
  minEventIntervalMs: 10,
  maxDuplicatePayloads: 10,
  duplicateWindowMinutes: 10,
  maxValueStddevs: 8,
  thresholdThrottle: 40,
  thresholdHold: 60,
  thresholdReject: 80,
}

const CONFIG_FIELDS: Array<keyof RiskConfigValues> = [
  'enabled',
  'maxEventsPerMinute',
  'maxEventsPerHour',
  'minEventIntervalMs',
  'maxDuplicatePayloads',
  'duplicateWindowMinutes',
  'maxValueStddevs',
  'thresholdThrottle',
  'thresholdHold',
  'thresholdReject',
]

export async function getRiskConfig(
  projectId: string,
  environmentId: string,
): Promise<RiskConfigValues | null> {
  const row = await db.riskConfig.findUnique({
    where: { projectId_environmentId: { projectId, environmentId } },
  })
  if (!row || !row.enabled) return null
  return {
    enabled: row.enabled,
    maxEventsPerMinute: row.maxEventsPerMinute,
    maxEventsPerHour: row.maxEventsPerHour,
    minEventIntervalMs: row.minEventIntervalMs,
    maxDuplicatePayloads: row.maxDuplicatePayloads,
    duplicateWindowMinutes: row.duplicateWindowMinutes,
    maxValueStddevs: row.maxValueStddevs,
    thresholdThrottle: row.thresholdThrottle,
    thresholdHold: row.thresholdHold,
    thresholdReject: row.thresholdReject,
  }
}

export async function upsertRiskConfig(
  projectId: string,
  environmentId: string,
  patch: Partial<Record<keyof RiskConfigValues, unknown>>,
): Promise<RiskConfigValues> {
  const merged: RiskConfigValues = { ...DEFAULT_RISK_CONFIG }
  // read existing row first so partial patches keep prior values
  const existing = await db.riskConfig.findUnique({
    where: { projectId_environmentId: { projectId, environmentId } },
  })
  if (existing) {
    for (const f of CONFIG_FIELDS) {
      ;(merged as unknown as Record<string, unknown>)[f] = (existing as unknown as Record<string, unknown>)[f]
    }
  }
  for (const f of CONFIG_FIELDS) {
    const v = patch?.[f]
    if (v === undefined) continue
    if (f === 'enabled') {
      ;(merged as unknown as Record<string, unknown>)[f] = v === true || v === 'true'
    } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      ;(merged as unknown as Record<string, unknown>)[f] = Math.floor(v)
    }
  }
  // keep threshold ordering sane: throttle <= hold <= reject
  if (merged.thresholdHold < merged.thresholdThrottle) merged.thresholdHold = merged.thresholdThrottle
  if (merged.thresholdReject < merged.thresholdHold) merged.thresholdReject = merged.thresholdHold

  await db.riskConfig.upsert({
    where: { projectId_environmentId: { projectId, environmentId } },
    create: { projectId, environmentId, ...merged },
    update: { ...merged },
  })
  return merged
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface RiskReason {
  code: string
  detail: string
  points: number
}

export type RiskVerdict = 'allow' | 'throttle' | 'hold' | 'reject'

export interface RiskAnalysis {
  score: number
  reasons: RiskReason[]
  verdict: RiskVerdict
}

export interface RiskAnalysisInput {
  projectId: string
  environmentId: string
  appUserId: string
  eventRowId: string // current event row (excluded from history lookups)
  eventType: string
  payload: Record<string, unknown>
  subjectId?: string | null
  occurredAt: Date
}

/**
 * Pure decision mapping — exported for tests.
 */
export function verdictFor(score: number, cfg: RiskConfigValues): RiskVerdict {
  if (score >= cfg.thresholdReject) return 'reject'
  if (score >= cfg.thresholdHold) return 'hold'
  if (score >= cfg.thresholdThrottle) return 'throttle'
  return 'allow'
}

export async function analyzeEventRisk(
  input: RiskAnalysisInput,
  cfg: RiskConfigValues,
): Promise<RiskAnalysis> {
  const reasons: RiskReason[] = []
  const { projectId, environmentId, appUserId, eventRowId, eventType, payload, occurredAt } = input

  // ---- 1. Velocity (per-minute / per-hour per actor) ----
  const minuteAgo = new Date(occurredAt.getTime() - 60_000)
  const hourAgo = new Date(occurredAt.getTime() - 3_600_000)
  const [countMinute, countHour] = await Promise.all([
    db.event.count({
      where: { projectId, environmentId, actorId: appUserId, occurredAt: { gte: minuteAgo } },
    }),
    db.event.count({
      where: { projectId, environmentId, actorId: appUserId, occurredAt: { gte: hourAgo } },
    }),
  ])
  if (cfg.maxEventsPerMinute > 0) {
    if (countMinute >= cfg.maxEventsPerMinute * 2) {
      reasons.push({
        code: 'VELOCITY_MINUTE',
        detail: `${countMinute} events in the last 60s (>= 2x limit ${cfg.maxEventsPerMinute}) — burst automation pattern`,
        points: 45,
      })
    } else if (countMinute > cfg.maxEventsPerMinute) {
      reasons.push({
        code: 'VELOCITY_MINUTE',
        detail: `${countMinute} events in the last 60s (limit ${cfg.maxEventsPerMinute})`,
        points: 30,
      })
    }
  }
  if (cfg.maxEventsPerHour > 0 && countHour > cfg.maxEventsPerHour) {
    reasons.push({
      code: 'VELOCITY_HOUR',
      detail: `${countHour} events in the last hour (limit ${cfg.maxEventsPerHour})`,
      points: 25,
    })
  }

  // ---- 2. Impossible speed (server clock is authoritative, §74) ----
  if (cfg.minEventIntervalMs > 0) {
    const prev = await db.event.findFirst({
      where: {
        projectId,
        environmentId,
        actorId: appUserId,
        id: { not: eventRowId },
      },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    })
    if (prev) {
      const gapMs = occurredAt.getTime() - prev.occurredAt.getTime()
      if (gapMs >= 0 && gapMs < cfg.minEventIntervalMs) {
        reasons.push({
          code: 'IMPOSSIBLE_SPEED',
          detail: `only ${gapMs}ms since the previous event (min human interval ${cfg.minEventIntervalMs}ms)`,
          points: 25,
        })
      }
    }
  }

  // ---- 3. Duplicate payload repetition (reward farming / scripted) ----
  if (cfg.maxDuplicatePayloads > 0 && cfg.duplicateWindowMinutes > 0) {
    const windowStart = new Date(occurredAt.getTime() - cfg.duplicateWindowMinutes * 60_000)
    const payloadJson = JSON.stringify(payload)
    const dupCount = await db.event.count({
      where: {
        projectId,
        environmentId,
        actorId: appUserId,
        eventType,
        payloadJson,
        occurredAt: { gte: windowStart },
      },
    })
    if (dupCount > cfg.maxDuplicatePayloads) {
      reasons.push({
        code: 'DUPLICATE_PAYLOAD',
        detail: `${dupCount} identical "${eventType}" payloads in ${cfg.duplicateWindowMinutes}min (limit ${cfg.maxDuplicatePayloads})`,
        points: 35,
      })
    }
  }

  // ---- 4. Value anomaly (leaderboard manipulation / fake outcomes) ----
  const numericProps = Object.entries(payload).filter(
    ([, v]) => typeof v === 'number' && Number.isFinite(v),
  )
  if (cfg.maxValueStddevs > 0 && numericProps.length > 0) {
    const recent = await db.event.findMany({
      where: { projectId, environmentId, eventType, id: { not: eventRowId } },
      orderBy: { occurredAt: 'desc' },
      take: 200,
      select: { payloadJson: true },
    })
    for (const [prop, value] of numericProps) {
      const samples: number[] = []
      for (const r of recent) {
        const p = parseJson<Record<string, unknown>>(r.payloadJson, {})
        if (typeof p[prop] === 'number' && Number.isFinite(p[prop] as number)) {
          samples.push(p[prop] as number)
        }
      }
      if (samples.length >= 10) {
        const mean = samples.reduce((a, b) => a + b, 0) / samples.length
        const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length
        const std = Math.sqrt(variance)
        if (std > 0) {
          const dev = Math.abs((value as number) - mean) / std
          if (dev > cfg.maxValueStddevs) {
            reasons.push({
              code: 'VALUE_ANOMALY',
              detail: `payload.${prop}=${value} is ${dev.toFixed(1)}σ from the recent mean ${mean.toFixed(1)} (threshold ${cfg.maxValueStddevs}σ)`,
              points: 30,
            })
          }
        }
      }
    }
  }

  // ---- 5. Multi-accounting (one subject driven by several actors, §74) ----
  if (input.subjectId) {
    const dayAgo = new Date(occurredAt.getTime() - 24 * 3_600_000)
    const actors = await db.event.findMany({
      where: {
        projectId,
        environmentId,
        subjectId: input.subjectId,
        occurredAt: { gte: dayAgo },
      },
      select: { actorId: true },
      distinct: ['actorId'],
    })
    const distinct = actors.map((a) => a.actorId).filter((x): x is string => !!x)
    if (distinct.length >= 2) {
      reasons.push({
        code: 'MULTI_ACCOUNT',
        detail: `subject "${input.subjectId}" driven by ${distinct.length} different users in 24h (referral/device sharing pattern)`,
        points: 30,
      })
    }
  }

  const score = Math.min(
    100,
    reasons.reduce((a, r) => a + r.points, 0),
  )
  return { score, reasons, verdict: verdictFor(score, cfg) }
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export async function createRiskFlag(input: {
  projectId: string
  environmentId: string
  eventRowId: string
  eventId: string
  appUserId: string
  eventType: string
  score: number
  decision: Exclude<RiskVerdict, 'allow'>
  reasons: RiskReason[]
}): Promise<string> {
  const row = await db.riskFlag.create({
    data: {
      projectId: input.projectId,
      environmentId: input.environmentId,
      eventRowId: input.eventRowId,
      eventId: input.eventId,
      appUserId: input.appUserId,
      eventType: input.eventType,
      score: input.score,
      decision: input.decision,
      reasonsJson: JSON.stringify(input.reasons),
    },
  })
  return row.id
}

export function serializeFlag(f: {
  id: string
  eventRowId: string | null
  eventId: string | null
  appUserId: string | null
  eventType: string
  score: number
  decision: string
  reasonsJson: string
  status: string
  resolvedBy: string | null
  resolvedAt: Date | null
  resultJson: string | null
  createdAt: Date
}) {
  return {
    id: f.id,
    eventId: f.eventId,
    eventRowId: f.eventRowId,
    appUserId: f.appUserId,
    eventType: f.eventType,
    score: f.score,
    decision: f.decision,
    reasons: parseJson<Array<{ code: string; detail: string; points: number }>>(f.reasonsJson, []),
    status: f.status,
    resolvedBy: f.resolvedBy,
    resolvedAt: f.resolvedAt,
    result: parseJson<Record<string, unknown> | null>(f.resultJson, null),
    createdAt: f.createdAt,
  }
}
