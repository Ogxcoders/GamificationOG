/**
 * GamificationOG — Generic Admin CRUD Resource Registry (Sections 6, 143).
 * Configuration-first: every domain object shares the common contract
 * (id, status, timestamps, metadata) plus domain-specific fields with
 * schema + semantic validation before persistence.
 */
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'
import { parseJson, type ConditionNode, type ActionDefinition } from '@/server/core/types'
import { validateConditionTree } from '@/server/engine/condition'
import { validateActionDefinition } from '@/server/engine/actions'
import { validateFormula } from '@/server/engine/formula'

export interface ResourceConfig {
  // prisma delegate key on db
  delegate: keyof typeof db
  // fields allowed in create/update (beyond projectId/environmentId)
  fields: string[]
  // JSON-typed fields stored as strings
  jsonFields?: string[]
  requiredOnCreate?: string[]
  // field-specific validation
  validate?: (data: Record<string, unknown>, mode: 'create' | 'update') => Promise<void> | void
  // audit target type
  auditType: string
  // unique field used by upsert-style create (optional)
  uniqueOn?: string[]
  // true when the underlying model is project-scoped (no environmentId column).
  // Content-level objects (notification templates, seasons) live at project level
  // so they are identical across environments and promoted via config exports.
  projectScoped?: boolean
}

const requireStatus = (d: Record<string, unknown>) => {
  if (d.status !== undefined && !['draft', 'validated', 'preview', 'approved', 'published', 'scheduled', 'active', 'paused', 'archived'].includes(String(d.status))) {
    throw new PlatformError({
      code: 'INVALID_STATUS',
      category: 'validation',
      message: `Status "${d.status}" is not a valid lifecycle status.`,
    })
  }
}

export const RESOURCES: Record<string, ResourceConfig> = {
  'event-schemas': {
    delegate: 'eventSchema',
    auditType: 'event_schema',
    projectScoped: true, // event schemas are contracts — identical across environments
    fields: ['name', 'version', 'description', 'payloadSchemaJson', 'status'],
    requiredOnCreate: ['name'],
    uniqueOn: ['name', 'version'],
    validate: (d) => {
      if (d.name !== undefined && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(String(d.name))) {
        throw new PlatformError({
          code: 'INVALID_NAME',
          category: 'validation',
          message: 'Event name must be dot-namespaced lowercase, e.g. "task.completed".',
        })
      }
      if (d.payloadSchemaJson !== undefined) {
        try {
          JSON.parse(String(d.payloadSchemaJson))
        } catch {
          throw new PlatformError({ code: 'INVALID_JSON', category: 'validation', message: 'payloadSchemaJson must be valid JSON.' })
        }
      }
      requireStatus(d)
    },
  },
  rules: {
    delegate: 'rule',
    auditType: 'rule',
    fields: ['name', 'description', 'eventType', 'conditionsJson', 'actionsJson', 'priority', 'cooldownSeconds', 'frequencyCap', 'frequencyPeriod', 'segmentId', 'validFrom', 'validTo', 'status', 'version', 'metadataJson'],
    requiredOnCreate: ['name', 'eventType', 'actionsJson'],
    validate: (d) => {
      if (d.eventType !== undefined && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(String(d.eventType))) {
        throw new PlatformError({
          code: 'INVALID_EVENT_TYPE',
          category: 'validation',
          message: 'Rule eventType must be dot-namespaced lowercase, e.g. "task.completed".',
        })
      }
      if (d.conditionsJson !== undefined) {
        const tree = parseJson<ConditionNode | null>(String(d.conditionsJson), null)
        if (tree === null) throw new PlatformError({ code: 'INVALID_JSON', category: 'validation', message: 'conditionsJson must be valid JSON.' })
        const r = validateConditionTree(tree)
        if (!r.valid) throw new PlatformError({ code: 'INVALID_CONDITION', category: 'validation', message: r.error ?? 'Invalid condition tree.' })
      }
      if (d.actionsJson !== undefined) {
        const actions = parseJson<ActionDefinition[] | null>(String(d.actionsJson), null)
        if (actions === null || !Array.isArray(actions)) {
          throw new PlatformError({ code: 'INVALID_JSON', category: 'validation', message: 'actionsJson must be a JSON array of actions.' })
        }
        for (const a of actions) {
          const r = validateActionDefinition(a)
          if (!r.valid) throw new PlatformError({ code: 'INVALID_ACTION', category: 'validation', message: r.error ?? 'Invalid action.' })
        }
      }
      if (d.priority !== undefined && (Number(d.priority) < 0 || Number(d.priority) > 10000)) {
        throw new PlatformError({ code: 'INVALID_PRIORITY', category: 'validation', message: 'Priority must be between 0 and 10000.' })
      }
      requireStatus(d)
    },
  },
  progression: {
    delegate: 'progressionTrack',
    auditType: 'progression_track',
    fields: ['code', 'name', 'type', 'baseXpPerLevel', 'growthFactor', 'maxLevel', 'customFormulaJson', 'status'],
    requiredOnCreate: ['code', 'name'],
    uniqueOn: ['code'],
    validate: (d) => {
      if (d.type !== undefined && !['linear', 'exponential', 'custom'].includes(String(d.type))) {
        throw new PlatformError({ code: 'INVALID_TYPE', category: 'validation', message: 'Track type must be linear, exponential, or custom.' })
      }
      if (d.customFormulaJson !== undefined && d.customFormulaJson !== null && String(d.customFormulaJson) !== 'null') {
        const parsed = parseJson<{ levelFormula?: string } | null>(String(d.customFormulaJson), null)
        if (parsed === null) throw new PlatformError({ code: 'INVALID_JSON', category: 'validation', message: 'customFormulaJson must be valid JSON.' })
        if (parsed.levelFormula) {
          const r = validateFormula(parsed.levelFormula)
          if (!r.valid) throw new PlatformError({ code: 'INVALID_FORMULA', category: 'validation', message: `levelFormula invalid: ${r.error}` })
        }
      }
      requireStatus(d)
    },
  },
  challenges: {
    delegate: 'challenge',
    auditType: 'challenge',
    fields: ['name', 'description', 'type', 'metricSource', 'eventType', 'payloadProperty', 'target', 'conditionsJson', 'rewardsJson', 'startsAt', 'endsAt', 'repeatability', 'segmentId', 'status', 'metadataJson'],
    requiredOnCreate: ['name', 'eventType', 'target'],
    validate: (d) => {
      if (d.type !== undefined && !['daily', 'weekly', 'monthly', 'one_time', 'timed', 'seasonal'].includes(String(d.type))) {
        throw new PlatformError({ code: 'INVALID_TYPE', category: 'validation', message: 'Challenge type must be daily/weekly/monthly/one_time/timed/seasonal.' })
      }
      if (d.metricSource !== undefined && !['event_count', 'event_sum', 'unique_entities', 'formula'].includes(String(d.metricSource))) {
        throw new PlatformError({ code: 'INVALID_METRIC', category: 'validation', message: 'metricSource must be event_count/event_sum/unique_entities/formula.' })
      }
      if (d.target !== undefined && (Number(d.target) <= 0 || !Number.isFinite(Number(d.target)))) {
        throw new PlatformError({ code: 'INVALID_TARGET', category: 'validation', message: 'Challenge target must be a positive number.' })
      }
      if (d.rewardsJson !== undefined) {
        const rewards = parseJson<ActionDefinition[] | null>(String(d.rewardsJson), null)
        if (rewards === null || !Array.isArray(rewards)) {
          throw new PlatformError({ code: 'INVALID_JSON', category: 'validation', message: 'rewardsJson must be a JSON array of actions.' })
        }
      }
      requireStatus(d)
    },
  },
  achievements: {
    delegate: 'achievement',
    auditType: 'achievement',
    fields: ['code', 'name', 'description', 'category', 'type', 'conditionsJson', 'points', 'icon', 'rewardsJson', 'hidden', 'status', 'metadataJson'],
    requiredOnCreate: ['code', 'name'],
    uniqueOn: ['code'],
    validate: (d) => {
      if (d.conditionsJson !== undefined) {
        const tree = parseJson<ConditionNode | null>(String(d.conditionsJson), null)
        if (tree === null) throw new PlatformError({ code: 'INVALID_JSON', category: 'validation', message: 'conditionsJson must be valid JSON.' })
        const r = validateConditionTree(tree)
        if (!r.valid) throw new PlatformError({ code: 'INVALID_CONDITION', category: 'validation', message: r.error ?? 'Invalid condition tree.' })
      }
      requireStatus(d)
    },
  },
  streaks: {
    delegate: 'streak',
    auditType: 'streak',
    fields: ['key', 'name', 'cadence', 'eventType', 'gracePeriodHours', 'freezeCount', 'milestonesJson', 'rewardMultiplierJson', 'segmentId', 'status'],
    requiredOnCreate: ['key', 'name', 'eventType'],
    uniqueOn: ['key'],
    validate: (d) => {
      if (d.cadence !== undefined && !['daily', 'weekly', 'custom'].includes(String(d.cadence))) {
        throw new PlatformError({ code: 'INVALID_CADENCE', category: 'validation', message: 'Streak cadence must be daily/weekly/custom.' })
      }
      requireStatus(d)
    },
  },
  rewards: {
    delegate: 'reward',
    auditType: 'reward',
    fields: ['code', 'name', 'description', 'type', 'configJson', 'eligibilityJson', 'stackRule', 'expiresAt', 'status', 'metadataJson'],
    requiredOnCreate: ['code', 'name', 'type'],
    uniqueOn: ['code'],
    validate: (d) => {
      if (d.type !== undefined && !['xp', 'points', 'currency', 'item', 'entitlement', 'badge', 'discount', 'custom'].includes(String(d.type))) {
        throw new PlatformError({ code: 'INVALID_TYPE', category: 'validation', message: 'Reward type must be xp/points/currency/item/entitlement/badge/discount/custom.' })
      }
      requireStatus(d)
    },
  },
  currencies: {
    delegate: 'currency',
    auditType: 'currency',
    fields: ['code', 'name', 'type', 'exchangeRate', 'capConfigJson', 'initialBalance', 'status'],
    requiredOnCreate: ['code', 'name'],
    uniqueOn: ['code'],
    validate: (d) => {
      if (d.code !== undefined && !/^[a-z][a-z0-9_]*$/.test(String(d.code))) {
        throw new PlatformError({ code: 'INVALID_CODE', category: 'validation', message: 'Currency code must be lowercase snake_case, e.g. "coins".' })
      }
      if (d.type !== undefined && !['soft', 'hard', 'premium'].includes(String(d.type))) {
        throw new PlatformError({ code: 'INVALID_TYPE', category: 'validation', message: 'Currency type must be soft/hard/premium.' })
      }
      requireStatus(d)
    },
  },
  items: {
    delegate: 'item',
    auditType: 'item',
    fields: ['code', 'name', 'description', 'type', 'stackable', 'maxStack', 'icon', 'metadataJson', 'status'],
    requiredOnCreate: ['code', 'name'],
    uniqueOn: ['code'],
    validate: (d) => {
      if (d.type !== undefined && !['consumable', 'durable', 'cosmetic', 'bundle', 'virtual_good'].includes(String(d.type))) {
        throw new PlatformError({ code: 'INVALID_TYPE', category: 'validation', message: 'Item type must be consumable/durable/cosmetic/bundle/virtual_good.' })
      }
      requireStatus(d)
    },
  },
  leaderboards: {
    delegate: 'leaderboard',
    auditType: 'leaderboard',
    fields: ['code', 'name', 'metricSource', 'eventType', 'payloadProperty', 'algorithm', 'timeWindow', 'tieBreaker', 'resetSchedule', 'maxEntries', 'rewardsJson', 'status', 'metadataJson'],
    requiredOnCreate: ['code', 'name'],
    uniqueOn: ['code'],
    validate: (d) => {
      if (d.algorithm !== undefined && !['highest', 'lowest'].includes(String(d.algorithm))) {
        throw new PlatformError({ code: 'INVALID_ALGORITHM', category: 'validation', message: 'Leaderboard algorithm must be highest/lowest.' })
      }
      if (d.timeWindow !== undefined && !['all_time', 'daily', 'weekly', 'monthly', 'seasonal'].includes(String(d.timeWindow))) {
        throw new PlatformError({ code: 'INVALID_WINDOW', category: 'validation', message: 'timeWindow must be all_time/daily/weekly/monthly/seasonal.' })
      }
      requireStatus(d)
    },
  },
  segments: {
    delegate: 'segment',
    auditType: 'segment',
    fields: ['name', 'description', 'type', 'conditionsJson', 'status'],
    requiredOnCreate: ['name'],
    validate: (d) => {
      if (d.conditionsJson !== undefined) {
        const tree = parseJson<ConditionNode | null>(String(d.conditionsJson), null)
        if (tree === null) throw new PlatformError({ code: 'INVALID_JSON', category: 'validation', message: 'conditionsJson must be valid JSON.' })
        const r = validateConditionTree(tree)
        if (!r.valid) throw new PlatformError({ code: 'INVALID_CONDITION', category: 'validation', message: r.error ?? 'Invalid condition tree.' })
      }
      requireStatus(d)
    },
  },
  experiments: {
    delegate: 'experiment',
    auditType: 'experiment',
    fields: ['key', 'name', 'description', 'variantsJson', 'trafficPercent', 'status', 'startedAt', 'endedAt'],
    requiredOnCreate: ['key', 'name', 'variantsJson'],
    uniqueOn: ['key'],
    validate: (d) => {
      if (d.variantsJson !== undefined) {
        const variants = parseJson<Array<{ key: string; weight: number }> | null>(String(d.variantsJson), null)
        if (variants === null || !Array.isArray(variants) || variants.length < 2) {
          throw new PlatformError({ code: 'INVALID_VARIANTS', category: 'validation', message: 'variantsJson must be an array with at least 2 variants.' })
        }
      }
      if (d.trafficPercent !== undefined && (Number(d.trafficPercent) < 0 || Number(d.trafficPercent) > 100)) {
        throw new PlatformError({ code: 'INVALID_TRAFFIC', category: 'validation', message: 'trafficPercent must be 0-100.' })
      }
      requireStatus(d)
    },
  },
  flags: {
    delegate: 'featureFlag',
    auditType: 'feature_flag',
    fields: ['key', 'description', 'enabled', 'rolloutPercent', 'segmentsJson', 'status'],
    requiredOnCreate: ['key'],
    uniqueOn: ['key'],
    validate: (d) => {
      if (d.rolloutPercent !== undefined && (Number(d.rolloutPercent) < 0 || Number(d.rolloutPercent) > 100)) {
        throw new PlatformError({ code: 'INVALID_ROLLOUT', category: 'validation', message: 'rolloutPercent must be 0-100.' })
      }
      requireStatus(d)
    },
  },
  'remote-configs': {
    delegate: 'remoteConfig',
    auditType: 'remote_config',
    fields: ['key', 'valueType', 'valueJson', 'status'],
    requiredOnCreate: ['key'],
    uniqueOn: ['key'],
    validate: (d) => {
      if (d.valueType !== undefined && !['string', 'number', 'boolean', 'json'].includes(String(d.valueType))) {
        throw new PlatformError({ code: 'INVALID_TYPE', category: 'validation', message: 'valueType must be string/number/boolean/json.' })
      }
      if (d.valueJson !== undefined) {
        try {
          JSON.parse(String(d.valueJson))
        } catch {
          throw new PlatformError({ code: 'INVALID_JSON', category: 'validation', message: 'valueJson must be valid JSON.' })
        }
      }
      requireStatus(d)
    },
  },
  'notification-templates': {
    delegate: 'notificationTemplate',
    auditType: 'notification_template',
    projectScoped: true,
    fields: ['key', 'name', 'channel', 'titleTemplate', 'bodyTemplate', 'variablesJson', 'status'],
    requiredOnCreate: ['key', 'name', 'titleTemplate'],
    uniqueOn: ['key'],
    validate: requireStatus,
  },
  webhooks: {
    delegate: 'webhookEndpoint',
    auditType: 'webhook_endpoint',
    fields: ['url', 'secret', 'eventsJson', 'status'],
    requiredOnCreate: ['url'],
    validate: (d) => {
      if (d.url !== undefined && !/^https?:\/\//.test(String(d.url))) {
        throw new PlatformError({ code: 'INVALID_URL', category: 'validation', message: 'Webhook URL must start with http:// or https://' })
      }
      requireStatus(d)
    },
  },
  seasons: {
    delegate: 'season',
    auditType: 'season',
    projectScoped: true,
    fields: ['name', 'number', 'startsAt', 'endsAt', 'gracePeriodHours', 'status', 'tracksJson', 'rankResetPolicy'],
    requiredOnCreate: ['name', 'startsAt', 'endsAt'],
    validate: (d) => {
      if (d.startsAt !== undefined && d.endsAt !== undefined && new Date(String(d.endsAt)) <= new Date(String(d.startsAt))) {
        throw new PlatformError({ code: 'INVALID_PERIOD', category: 'validation', message: 'Season end must be after start.' })
      }
      requireStatus(d)
    },
  },
}

// default list orderBy per resource (fallback: createdAt desc)
export function listOrderBy(resource: string): Record<string, string> | Array<Record<string, string>> {
  switch (resource) {
    case 'rules': return [{ priority: 'desc' }, { createdAt: 'desc' }]
    default: return { createdAt: 'desc' }
  }
}
