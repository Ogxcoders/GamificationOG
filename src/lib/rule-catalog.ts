/**
 * GamificationOG — Rule Builder Catalog (client-safe, Section 13/§51).
 * Declarative specs powering the visual WHEN/IF/THEN editor: action
 * param descriptors, operator metadata, field suggestions, and value
 * coercion that mirrors the engine's loose-typed JSON conventions.
 */
import { COMPARISON_OPERATORS, FIELD_NAMESPACES } from '@/server/engine/condition'

// ---------------------------------------------------------------------------
// Value coercion — string input -> JSON literal (lossless for common shapes)
// ---------------------------------------------------------------------------

/** Operators that take no right-hand value. */
export const NO_VALUE_OPERATORS = ['exists', 'not_exists', 'is_null', 'is_not_null']

/** Operators taking two values (range bounds). */
export const TWO_VALUE_OPERATORS = ['between']

/** Operators whose value is a list (comma-separated in the UI). */
export const LIST_OPERATORS = ['in', 'not_in']

export function coerceValue(raw: string): unknown {
  const s = raw.trim()
  if (s === '') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      return JSON.parse(s)
    } catch {
      return raw
    }
  }
  return s
}

export function parseListValue(raw: string): unknown[] {
  const s = raw.trim()
  if (s === '') return []
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) return arr
    } catch {
      /* fall through to comma split */
    }
  }
  return s.split(',').map((part) => coerceValue(part))
}

/** Render a stored JSON value back into an editable string. */
export function valueToInput(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// ---------------------------------------------------------------------------
// Action catalog — mirrors the server action registry (src/server/engine/actions.ts)
// ---------------------------------------------------------------------------

export type ParamKind = 'formula' | 'number' | 'code' | 'text' | 'select' | 'json' | 'any'

export interface ParamSpec {
  key: string
  label: string
  kind: ParamKind
  required?: boolean
  placeholder?: string
  hint?: string
  options?: Array<{ value: string; label: string }>
}

export interface ActionSpec {
  type: string
  domain: string
  description: string
  params: ParamSpec[]
}

const FORMULA_HINT = 'Number or formula, e.g. 10 * user.level'

export const ACTION_CATALOG: ActionSpec[] = [
  {
    type: 'award_xp',
    domain: 'progression',
    description: 'Award XP to a progression track (formulas allowed)',
    params: [
      { key: 'amount', label: 'Amount', kind: 'formula', required: true, placeholder: '50', hint: FORMULA_HINT },
      { key: 'track', label: 'Track', kind: 'code', placeholder: 'default', hint: 'Progression track code — default track when empty' },
    ],
  },
  {
    type: 'add_currency',
    domain: 'economy',
    description: 'Credit a currency via the ledger',
    params: [
      { key: 'currency', label: 'Currency code', kind: 'code', required: true, placeholder: 'gems' },
      { key: 'amount', label: 'Amount', kind: 'formula', required: true, placeholder: '10', hint: FORMULA_HINT },
    ],
  },
  {
    type: 'spend_currency',
    domain: 'economy',
    description: 'Debit a currency via the ledger',
    params: [
      { key: 'currency', label: 'Currency code', kind: 'code', required: true, placeholder: 'gems' },
      { key: 'amount', label: 'Amount', kind: 'formula', required: true, placeholder: '10', hint: FORMULA_HINT },
    ],
  },
  {
    type: 'grant_item',
    domain: 'inventory',
    description: 'Grant an item to user inventory',
    params: [
      { key: 'item', label: 'Item code', kind: 'code', required: true, placeholder: 'booster' },
      { key: 'quantity', label: 'Quantity', kind: 'number', placeholder: '1', hint: 'Defaults to 1' },
    ],
  },
  {
    type: 'grant_reward',
    domain: 'rewards',
    description: 'Resolve and grant a configured reward',
    params: [{ key: 'reward', label: 'Reward code', kind: 'code', required: true, placeholder: 'daily_chest' }],
  },
  {
    type: 'unlock_achievement',
    domain: 'achievements',
    description: 'Directly unlock an achievement',
    params: [{ key: 'achievement', label: 'Achievement', kind: 'code', required: true, placeholder: 'first_task' }],
  },
  {
    type: 'update_challenge_progress',
    domain: 'challenges',
    description: 'Advance challenge progress by a delta',
    params: [
      { key: 'challenge', label: 'Challenge', kind: 'code', required: true, placeholder: 'daily_quests' },
      { key: 'delta', label: 'Delta', kind: 'number', placeholder: '1', hint: 'Defaults to 1' },
    ],
  },
  {
    type: 'update_streak',
    domain: 'streaks',
    description: 'Mark a streak qualifying event',
    params: [{ key: 'streak', label: 'Streak code', kind: 'code', required: true, placeholder: 'daily_checkin' }],
  },
  {
    type: 'update_leaderboard',
    domain: 'competition',
    description: 'Set or increment a leaderboard score',
    params: [
      { key: 'leaderboard', label: 'Leaderboard', kind: 'code', required: true, placeholder: 'weekly_xp' },
      { key: 'score', label: 'Score', kind: 'formula', required: true, placeholder: '50', hint: FORMULA_HINT },
      { key: 'mode', label: 'Mode', kind: 'select', options: [
        { value: 'increment', label: 'Increment' },
        { value: 'set', label: 'Set (absolute)' },
      ] },
    ],
  },
  {
    type: 'send_notification',
    domain: 'notifications',
    description: 'Send a templated or direct notification',
    params: [
      { key: 'template', label: 'Template key', kind: 'code', placeholder: 'welcome_back', hint: 'Either a template or a direct title is required' },
      { key: 'title', label: 'Title', kind: 'text', placeholder: 'Streak saved!' },
      { key: 'body', label: 'Body', kind: 'text', placeholder: 'Come back tomorrow for a bigger bonus' },
      { key: 'type', label: 'Type', kind: 'select', options: [
        { value: 'info', label: 'Info' },
        { value: 'success', label: 'Success' },
        { value: 'warning', label: 'Warning' },
        { value: 'error', label: 'Error' },
      ] },
    ],
  },
  {
    type: 'grant_entitlement',
    domain: 'monetization',
    description: 'Grant an entitlement (access right) to a user',
    params: [
      { key: 'code', label: 'Entitlement code', kind: 'code', required: true, placeholder: 'premium' },
      { key: 'days', label: 'Days', kind: 'number', placeholder: '30', hint: 'Leave empty for permanent' },
    ],
  },
  {
    type: 'set_user_attribute',
    domain: 'identity',
    description: 'Set a user profile attribute',
    params: [
      { key: 'key', label: 'Key', kind: 'text', required: true, placeholder: 'timezone' },
      { key: 'value', label: 'Value', kind: 'any', placeholder: 'Europe/Berlin' },
    ],
  },
  {
    type: 'set_user_variable',
    domain: 'state',
    description: 'Set a user variable (custom state)',
    params: [
      { key: 'key', label: 'Key', kind: 'text', required: true, placeholder: 'boost_multiplier' },
      { key: 'value', label: 'Value', kind: 'any', placeholder: '2' },
    ],
  },
  {
    type: 'emit_event',
    domain: 'events',
    description: 'Emit a derived event back into the gateway',
    params: [
      { key: 'type', label: 'Event type', kind: 'code', required: true, placeholder: 'challenge.progressed' },
      { key: 'payload', label: 'Payload', kind: 'json', placeholder: '{ "amount": 1 }' },
    ],
  },
]

export const ACTION_BY_TYPE: Record<string, ActionSpec> = Object.fromEntries(
  ACTION_CATALOG.map((a) => [a.type, a]),
)

// ---------------------------------------------------------------------------
// Condition metadata
// ---------------------------------------------------------------------------

export const OPERATORS = COMPARISON_OPERATORS

export const FIELD_SUGGESTIONS: string[] = Array.from(
  new Set([
    ...FIELD_NAMESPACES,
    'event.payload.amount',
    'event.payload.count',
    'event.payload.level',
    'event.payload.name',
    'event.payload.source',
    'user.attribute.timezone',
    'user.currency.gems',
    'user.item.booster',
  ]),
).sort()

export function operatorNeedsValue(op: string): boolean {
  return !NO_VALUE_OPERATORS.includes(op)
}

export function operatorTakesList(op: string): boolean {
  return LIST_OPERATORS.includes(op)
}

export function operatorTakesTwoValues(op: string): boolean {
  return TWO_VALUE_OPERATORS.includes(op)
}

/** Operator label for selects. */
export function operatorLabel(op: string): string {
  const labels: Record<string, string> = {
    eq: '= equals',
    ne: '≠ not equals',
    gt: '> greater than',
    lt: '< less than',
    gte: '≥ greater or equal',
    lte: '≤ less or equal',
    in: 'in (list)',
    not_in: 'not in (list)',
    contains: 'contains',
    not_contains: 'not contains',
    starts_with: 'starts with',
    ends_with: 'ends with',
    between: 'between (range)',
    exists: 'exists',
    not_exists: 'does not exist',
    is_null: 'is null',
    is_not_null: 'is not null',
  }
  return labels[op] ?? op
}
