/**
 * GamificationOG — Core Types
 * Canonical TypeScript contracts mirroring the Prisma domain model and the
 * Master Plan's Common Object Contract (Section 6) and lifecycle (Section 7).
 */
import { db } from '@/lib/db'
import type {
  AppUser, Challenge, ChallengeProgress, Currency, Event, EventSchema,
  FeatureFlag, Item, Leaderboard, LedgerTransaction, ProgressionTrack,
  Rule, Segment, Streak, UserAchievement, UserProgression, WalletBalance,
} from '@prisma/client'

// ---------------------------------------------------------------------------
// Object lifecycle (Section 7)
// ---------------------------------------------------------------------------
export const OBJECT_STATUSES = [
  'draft', 'validated', 'preview', 'approved', 'published',
  'scheduled', 'active', 'paused', 'archived',
] as const
export type ObjectStatus = (typeof OBJECT_STATUSES)[number]

export const ACTIVE_STATUSES: readonly string[] = ['active', 'published']

// ---------------------------------------------------------------------------
// Canonical event shape (Section 10)
// ---------------------------------------------------------------------------
export interface CanonicalEvent {
  event_id: string
  event_type: string
  event_version: number
  project_id: string
  environment_id: string
  actor_id: string | null
  subject_id: string | null
  source: string
  occurred_at: string
  received_at: string
  correlation_id: string | null
  causation_id: string | null
  idempotency_key: string | null
  payload: Record<string, unknown>
  metadata: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Condition tree (Section 13 — Rule Engine)
// ---------------------------------------------------------------------------
export type ComparisonOperator =
  | 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte'
  | 'in' | 'not_in' | 'contains' | 'not_contains'
  | 'starts_with' | 'ends_with'
  | 'between' | 'exists' | 'not_exists' | 'is_null' | 'is_not_null'

export interface FieldCondition {
  field: string
  operator: ComparisonOperator
  value?: unknown
  value2?: unknown // for between
}

export interface LogicalCondition {
  op: 'and' | 'or' | 'not'
  conditions: ConditionNode[]
}

export type ConditionNode = FieldCondition | LogicalCondition

export function isLogicalCondition(c: ConditionNode): c is LogicalCondition {
  return (c as LogicalCondition).op !== undefined && (c as LogicalCondition).conditions !== undefined
}

export function emptyCondition(): LogicalCondition {
  return { op: 'and', conditions: [] }
}

// ---------------------------------------------------------------------------
// Action definitions (Section 15 — Action Engine)
// ---------------------------------------------------------------------------
export const ACTION_TYPES = [
  'award_xp', 'add_currency', 'spend_currency', 'grant_item', 'grant_reward',
  'unlock_achievement', 'update_challenge_progress', 'update_streak',
  'update_leaderboard', 'send_notification', 'set_user_attribute',
  'set_user_variable', 'emit_event',
] as const
export type ActionType = (typeof ACTION_TYPES)[number]

export interface ActionDefinition {
  type: ActionType
  params: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Formula engine types (Section 14)
// ---------------------------------------------------------------------------
export interface FormulaVariables {
  [namespace: string]: number | string | boolean | Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Context engine shape (Section 12)
// ---------------------------------------------------------------------------
export interface EngineContext {
  event: {
    id: string
    type: string
    version: number
    payload: Record<string, unknown>
    occurredAt: Date
    source: string
  }
  user: {
    id: string
    externalId: string
    displayName: string | null
    isAnonymous: boolean
    attributes: Record<string, unknown>
    status: string
    createdAt: Date
  }
  project: {
    id: string
    name: string
    timezone: string
  }
  environment: {
    id: string
    name: string
  }
  time: {
    now: Date
    dayOfWeek: number
    hourOfDay: number
    dateKey: string
    unixSeconds: number
  }
  progression: {
    tracks: Array<{ code: string; xp: number; level: number }>
  }
  economy: {
    balances: Array<{ currency: string; balance: number }>
  }
  inventory: {
    items: Array<{ code: string; quantity: number }>
  }
  segments: {
    ids: string[]
    names: string[]
  }
  flags: {
    [key: string]: boolean
  }
  experiment: {
    [experimentKey: string]: string
  }
  metrics: {
    [key: string]: number
  }
}

// ---------------------------------------------------------------------------
// Event ingestion envelope + result
// ---------------------------------------------------------------------------
export interface EventIngestionRequest {
  event_type: string
  event_version?: number
  external_user_id?: string
  subject_id?: string | null
  source?: string
  occurred_at?: string
  idempotency_key?: string | null
  correlation_id?: string | null
  causation_id?: string | null
  payload?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface ActionExecutionResult {
  action: string
  status: 'executed' | 'skipped' | 'failed'
  detail: string
  before?: unknown
  after?: unknown
}

export interface EventProcessingResult {
  eventId: string
  status: 'processed' | 'failed' | 'duplicate' | 'skipped'
  error?: string
  traceId?: string
  actions: ActionExecutionResult[]
  stateDelta: {
    xpAwarded: number
    levelUps: Array<{ track: string; from: number; to: number }>
    currencyChanges: Array<{ currency: string; amount: number; balanceAfter: number }>
    itemsGranted: Array<{ item: string; quantity: number }>
    achievementsUnlocked: Array<{ code: string; name: string }>
    challengesCompleted: Array<{ name: string; reward?: string }>
    streak: { key: string; current: number; best: number } | null
    leaderboardUpdates: Array<{ leaderboard: string; score: number; rank: number | null }>
    notifications: number
  }
}

// ---------------------------------------------------------------------------
// Decision trace (Section 70)
// ---------------------------------------------------------------------------
export interface TraceStep {
  step: number
  name: string
  detail: string
  matched?: boolean
  durationMs: number
  input?: unknown
  output?: unknown
}

// ---------------------------------------------------------------------------
// Auth / actor model (Section 189)
// ---------------------------------------------------------------------------
export type ActorType = 'human' | 'system' | 'plugin' | 'ai' | 'automation'

export interface AuthenticatedApiKey {
  apiKeyId: string
  projectId: string
  environmentId: string
  scopes: string[]
}

export interface AuthenticatedAdmin {
  adminUserId: string
  email: string
  name: string
  role: string
}

// ---------------------------------------------------------------------------
// JSON helper convention (SQLite backend)
// ---------------------------------------------------------------------------
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function safeJson(raw: string | null | undefined): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// ---------------------------------------------------------------------------
// Domain object re-exports for convenience
// ---------------------------------------------------------------------------
export type {
  AppUser, Challenge, ChallengeProgress, Currency, Event, EventSchema,
  FeatureFlag, Item, Leaderboard, LedgerTransaction, ProgressionTrack,
  Rule, Segment, Streak, UserAchievement, UserProgression, WalletBalance,
}

export { db }
