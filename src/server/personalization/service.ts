/**
 * GamificationOG — Personalization engine (Section 34).
 * Targeted overrides of remote config values. Evaluation chain:
 *   remote config (base) → personalization rules (condition-targeted,
 *   highest priority wins) → user variable overrides ($custom namespace).
 * Pure configuration — no hardcoded product logic (§2).
 */
import { db } from '@/lib/db'
import { parseJson, type ConditionNode } from '@/server/core/types'
import { buildTargetingContext, matchesTargeting } from '@/server/monetization/service'

/**
 * Apply personalization rules to a base config map for a user.
 * Rules target `key` (a remote-config key). Among matching rules for
 * the same key, the highest priority wins (ties: latest createdAt).
 */
export async function personalizeConfig(params: {
  projectId: string
  environmentId: string
  appUserId: string
  config: Record<string, unknown>
}) {
  const rules = await db.personalizationRule.findMany({
    where: { projectId: params.projectId, environmentId: params.environmentId, status: 'active' },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  })
  if (rules.length === 0) return { config: params.config, applied: [] as string[] }

  const context = await buildTargetingContext(params.projectId, params.environmentId, params.appUserId)
  const result: Record<string, unknown> = { ...params.config }
  const applied: string[] = []
  const seenKeys = new Set<string>()

  for (const rule of rules) {
    if (seenKeys.has(rule.key)) continue // first match (highest priority) wins
    if (!matchesTargeting(rule.targetingJson, context)) continue
    const value = parseJson<{ value?: unknown } | unknown>(rule.valueJson, rule.valueJson)
    result[rule.key] = value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)
      ? (value as { value: unknown }).value
      : value
    seenKeys.add(rule.key)
    applied.push(rule.key)
  }

  return { config: result, applied }
}

/**
 * List which rules would apply for a user (admin preview / explain UI §311).
 */
export async function previewPersonalization(params: {
  projectId: string
  environmentId: string
  appUserId: string
}) {
  const rules = await db.personalizationRule.findMany({
    where: { projectId: params.projectId, environmentId: params.environmentId, status: 'active' },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  })
  const context = await buildTargetingContext(params.projectId, params.environmentId, params.appUserId)
  const seenKeys = new Set<string>()
  return rules.map((r) => {
    const matches = matchesTargeting(r.targetingJson, context)
    const effective = matches && !seenKeys.has(r.key)
    if (effective) seenKeys.add(r.key)
    return {
      id: r.id,
      key: r.key,
      valueJson: r.valueJson,
      priority: r.priority,
      description: r.description,
      matches,
      effective,
    }
  })
}

export type { ConditionNode }
