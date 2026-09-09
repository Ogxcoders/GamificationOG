/**
 * GamificationOG — Condition Engine (Section 13)
 * Declarative condition trees supporting nesting and composition.
 * Operators: eq, ne, gt, lt, gte, lte, in, not_in, contains, not_contains,
 * starts_with, ends_with, between, exists, not_exists, is_null, is_not_null.
 * Logical ops: and / or / not with arbitrary nesting.
 */
import type { ConditionNode, FieldCondition, LogicalCondition, ComparisonOperator } from '../core/types'
import { isLogicalCondition } from '../core/types'

export const COMPARISON_OPERATORS: ComparisonOperator[] = [
  'eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'in', 'not_in',
  'contains', 'not_contains', 'starts_with', 'ends_with',
  'between', 'exists', 'not_exists', 'is_null', 'is_not_null',
]

export const FIELD_NAMESPACES = [
  'event.type', 'event.version', 'event.payload', 'event.source',
  'user.external_id', 'user.display_name', 'user.anonymous', 'user.attribute',
  'user.level', 'user.xp', 'user.segment', 'user.currency', 'user.item',
  'project.id', 'project.name',
  'environment.name',
  'time.day_of_week', 'time.hour_of_day', 'time.date_key',
]

/** Resolve a dot-path against the context object. */
export function resolveField(field: string, context: Record<string, unknown>): unknown {
  const parts = field.split('.')
  let current: unknown = context
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function toComparable(v: unknown): number | string | boolean | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
  return JSON.stringify(v)
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (!Number.isNaN(n)) return n
  }
  if (typeof v === 'boolean') return v ? 1 : 0
  return null
}

function compare(op: string, a: number, b: number): boolean {
  switch (op) {
    case 'gt': return a > b
    case 'lt': return a < b
    case 'gte': return a >= b
    case 'lte': return a <= b
    default: return false
  }
}

export function evaluateFieldCondition(cond: FieldCondition, context: Record<string, unknown>): boolean {
  const actual = resolveField(cond.field, context)

  switch (cond.operator) {
    case 'exists': return actual !== undefined && actual !== null
    case 'not_exists': return actual === undefined || actual === null
    case 'is_null': return actual === null || actual === undefined
    case 'is_not_null': return actual !== null && actual !== undefined

    case 'eq': {
      const a = toComparable(actual)
      const b = toComparable(cond.value)
      if (typeof a === 'number' && typeof b === 'number') return a === b
      if (typeof a === 'boolean' || typeof b === 'boolean') {
        return String(a) === String(b)
      }
      return a === b
    }
    case 'ne': {
      const a = toComparable(actual)
      const b = toComparable(cond.value)
      if (typeof a === 'number' && typeof b === 'number') return a !== b
      if (typeof a === 'boolean' || typeof b === 'boolean') {
        return String(a) !== String(b)
      }
      return a !== b
    }

    case 'gt': case 'lt': case 'gte': case 'lte': {
      const a = asNumber(actual)
      const b = asNumber(cond.value)
      if (a === null || b === null) {
        // fall back to string comparison
        const sa = toComparable(actual)
        const sb = toComparable(cond.value)
        if (typeof sa === 'string' && typeof sb === 'string') return stringCompare(cond.operator, sa, sb)
        return false
      }
      return compare(cond.operator, a, b)
    }

    case 'in': {
      if (!Array.isArray(cond.value)) return false
      return cond.value.some((v) => toComparable(v) === toComparable(actual))
    }
    case 'not_in': {
      if (!Array.isArray(cond.value)) return true
      return !cond.value.some((v) => toComparable(v) === toComparable(actual))
    }

    case 'contains': case 'not_contains': {
      const a = toComparable(actual)
      const contains = containsValue(a, cond.value)
      return cond.operator === 'contains' ? contains : !contains
    }

    case 'starts_with': {
      const a = toComparable(actual)
      if (typeof a !== 'string') return false
      const b = toComparable(cond.value)
      return typeof b === 'string' && a.startsWith(b)
    }
    case 'ends_with': {
      const a = toComparable(actual)
      if (typeof a !== 'string') return false
      const b = toComparable(cond.value)
      return typeof b === 'string' && a.endsWith(b)
    }

    case 'between': {
      const a = asNumber(actual)
      const lo = asNumber(cond.value)
      const hi = asNumber(cond.value2)
      if (a === null || lo === null || hi === null) return false
      return a >= Math.min(lo, hi) && a <= Math.max(lo, hi)
    }

    default:
      return false
  }
}

function stringCompare(op: string, a: string, b: string): boolean {
  switch (op) {
    case 'gt': return a > b
    case 'lt': return a < b
    case 'gte': return a >= b
    case 'lte': return a <= b
    default: return false
  }
}

function containsValue(haystack: number | string | boolean | null, needle: unknown): boolean {
  if (haystack === null) return false
  if (typeof haystack === 'string') return haystack.includes(String(needle ?? ''))
  if (typeof haystack === 'number') {
    const n = asNumber(needle)
    return n !== null && haystack === n
  }
  return false
}

export function evaluateCondition(node: ConditionNode, context: Record<string, unknown>): boolean {
  if (!node) return true
  if (isLogicalCondition(node)) {
    return evaluateLogical(node, context)
  }
  return evaluateFieldCondition(node as FieldCondition, context)
}

function evaluateLogical(node: LogicalCondition, context: Record<string, unknown>): boolean {
  if (!node.conditions || node.conditions.length === 0) {
    // empty condition tree matches everything
    return node.op === 'not' ? false : true
  }
  switch (node.op) {
    case 'and':
      return node.conditions.every((c) => evaluateCondition(c, context))
    case 'or':
      return node.conditions.some((c) => evaluateCondition(c, context))
    case 'not':
      return !evaluateCondition(node.conditions[0], context)
    default:
      return false
  }
}

/** Validation for stored condition trees. */
export function validateConditionTree(node: unknown, depth = 0): { valid: boolean; error?: string } {
  if (depth > 10) return { valid: false, error: 'Condition tree exceeds maximum depth of 10' }
  if (node === null || node === undefined) return { valid: true }
  if (typeof node !== 'object') return { valid: false, error: 'Condition must be an object' }
  const n = node as Record<string, unknown>
  if (n.op !== undefined && n.conditions !== undefined) {
    if (!['and', 'or', 'not'].includes(String(n.op))) {
      return { valid: false, error: `Logical operator must be and/or/not, got "${n.op}"` }
    }
    if (!Array.isArray(n.conditions)) return { valid: false, error: '"conditions" must be an array' }
    if (n.op === 'not' && (n.conditions as unknown[]).length !== 1) {
      return { valid: false, error: '"not" must wrap exactly one condition' }
    }
    for (const child of n.conditions) {
      const r = validateConditionTree(child, depth + 1)
      if (!r.valid) return r
    }
    return { valid: true }
  }
  if (n.field !== undefined && n.operator !== undefined) {
    if (typeof n.field !== 'string' || n.field.length === 0) return { valid: false, error: '"field" must be a non-empty string' }
    if (!COMPARISON_OPERATORS.includes(n.operator as ComparisonOperator)) {
      return { valid: false, error: `Unknown operator "${n.operator}". Available: ${COMPARISON_OPERATORS.join(', ')}` }
    }
    const needsValue = !['exists', 'not_exists', 'is_null', 'is_not_null'].includes(String(n.operator))
    if (needsValue && n.value === undefined) {
      return { valid: false, error: `Operator "${n.operator}" requires a "value"` }
    }
    return { valid: true }
  }
  return { valid: false, error: 'Condition must be either { op, conditions } or { field, operator, value }' }
}
