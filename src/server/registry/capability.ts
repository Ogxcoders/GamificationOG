/**
 * GamificationOG — Capability Registry (Section 2.3)
 * First-class discovery of supported extension points: object types,
 * events, actions, conditions, operators, formula functions, domains.
 * New capabilities register here instead of modifying the core engine.
 */
import { getActionRegistry } from '../engine/actions'
import { COMPARISON_OPERATORS } from '../engine/condition'
import { FORMULA_FUNCTIONS } from '../engine/formula'

export interface Capability {
  kind: string
  name: string
  domain: string
  description: string
}

export const DOMAIN_OBJECT_TYPES: Capability[] = [
  { kind: 'object_type', name: 'organization', domain: 'tenancy', description: 'Customer/company boundary' },
  { kind: 'object_type', name: 'workspace', domain: 'tenancy', description: 'Grouping of related projects' },
  { kind: 'object_type', name: 'project', domain: 'tenancy', description: 'An application/game/product' },
  { kind: 'object_type', name: 'environment', domain: 'tenancy', description: 'development/staging/production isolation' },
  { kind: 'object_type', name: 'app_user', domain: 'identity', description: 'End user of a customer product' },
  { kind: 'object_type', name: 'api_key', domain: 'identity', description: 'SDK authentication credential' },
  { kind: 'object_type', name: 'event_schema', domain: 'events', description: 'Payload contract for an event type' },
  { kind: 'object_type', name: 'event', domain: 'events', description: 'Immutable ingested event record' },
  { kind: 'object_type', name: 'rule', domain: 'rules', description: 'WHEN/IF/THEN event-driven automation' },
  { kind: 'object_type', name: 'progression_track', domain: 'progression', description: 'XP -> level configuration' },
  { kind: 'object_type', name: 'challenge', domain: 'challenges', description: 'Measurable objective container' },
  { kind: 'object_type', name: 'achievement', domain: 'achievements', description: 'Unlockable recognition' },
  { kind: 'object_type', name: 'streak', domain: 'streaks', description: 'Cadence-based consistency system' },
  { kind: 'object_type', name: 'reward', domain: 'rewards', description: 'Abstract outcome definition' },
  { kind: 'object_type', name: 'currency', domain: 'economy', description: 'Virtual currency definition' },
  { kind: 'object_type', name: 'ledger_transaction', domain: 'economy', description: 'Immutable balance mutation record' },
  { kind: 'object_type', name: 'item', domain: 'inventory', description: 'Inventory item definition' },
  { kind: 'object_type', name: 'leaderboard', domain: 'competition', description: 'Ranking system definition' },
  { kind: 'object_type', name: 'season', domain: 'competition', description: 'Temporal container with reward tracks' },
  { kind: 'object_type', name: 'segment', domain: 'segmentation', description: 'Dynamic user cohort query' },
  { kind: 'object_type', name: 'experiment', domain: 'experiments', description: 'A/B variant allocation' },
  { kind: 'object_type', name: 'feature_flag', domain: 'experiments', description: 'Gated capability toggle' },
  { kind: 'object_type', name: 'remote_config', domain: 'experiments', description: 'Runtime configuration value' },
  { kind: 'object_type', name: 'notification', domain: 'notifications', description: 'User message record' },
  { kind: 'object_type', name: 'notification_template', domain: 'notifications', description: 'Interpolated message template' },
  { kind: 'object_type', name: 'decision_trace', domain: 'observability', description: 'Step-by-step engine decision record' },
  { kind: 'object_type', name: 'audit_log', domain: 'security', description: 'Immutable admin mutation record' },
  { kind: 'object_type', name: 'webhook_endpoint', domain: 'integrations', description: 'External delivery target' },
]

export const EVENT_CATALOG: Capability[] = [
  { kind: 'event', name: 'user.identify', domain: 'identity', description: 'User identified/created' },
  { kind: 'event', name: 'user.session.start', domain: 'identity', description: 'Session started' },
  { kind: 'event', name: 'xp.awarded', domain: 'progression', description: 'XP granted' },
  { kind: 'event', name: 'level.up', domain: 'progression', description: 'User leveled up' },
  { kind: 'event', name: 'currency.earned', domain: 'economy', description: 'Currency credited' },
  { kind: 'event', name: 'currency.spent', domain: 'economy', description: 'Currency debited' },
  { kind: 'event', name: 'item.granted', domain: 'inventory', description: 'Item granted' },
  { kind: 'event', name: 'achievement.unlocked', domain: 'achievements', description: 'Achievement unlocked' },
  { kind: 'event', name: 'challenge.completed', domain: 'challenges', description: 'Challenge completed' },
  { kind: 'event', name: 'streak.updated', domain: 'streaks', description: 'Streak state changed' },
  { kind: 'event', name: 'leaderboard.updated', domain: 'competition', description: 'Leaderboard score changed' },
  { kind: 'event', name: 'notification.sent', domain: 'notifications', description: 'Notification delivered' },
]

export function getFullRegistry(): Capability[] {
  const actions = getActionRegistry().map((a) => ({
    kind: 'action',
    name: a.type,
    domain: a.domain,
    description: a.description,
  }))

  const operators = COMPARISON_OPERATORS.map((op) => ({
    kind: 'condition_operator',
    name: op,
    domain: 'rules',
    description: `Condition operator: ${op}`,
  }))

  const logical = (['and', 'or', 'not'] as const).map((op) => ({
    kind: 'condition_operator',
    name: op,
    domain: 'rules',
    description: `Logical combinator: ${op}`,
  }))

  const functions = FORMULA_FUNCTIONS.map((fn) => ({
    kind: 'formula_function',
    name: fn,
    domain: 'formulas',
    description: `Formula function: ${fn}()`,
  }))

  return [...DOMAIN_OBJECT_TYPES, ...EVENT_CATALOG, ...actions, ...logical, ...operators, ...functions]
}

export function getRegistrySummary() {
  const registry = getFullRegistry()
  const byKind = registry.reduce<Record<string, number>>((acc, c) => {
    acc[c.kind] = (acc[c.kind] ?? 0) + 1
    return acc
  }, {})
  const byDomain = registry.reduce<Record<string, number>>((acc, c) => {
    acc[c.domain] = (acc[c.domain] ?? 0) + 1
    return acc
  }, {})
  return { total: registry.length, byKind, byDomain }
}
