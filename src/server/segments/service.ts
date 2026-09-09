/**
 * GamificationOG — Segmentation (Section 33)
 * Segments are dynamic queries over the engine context. Reusable by
 * challenges, rewards, paywalls, notifications, experiments, rules.
 */
import { db } from '@/lib/db'
import { parseJson, type ConditionNode } from '../core/types'
import { evaluateCondition } from '../engine/condition'
import { deterministicBucket } from '../time/engine'

export async function evaluateUserSegments(params: {
  projectId: string
  environmentId: string
  context: Record<string, unknown>
}): Promise<{ ids: string[]; names: string[] }> {
  const segments = await db.segment.findMany({
    where: { projectId: params.projectId, environmentId: params.environmentId, status: 'active' },
  })

  const ids: string[] = []
  const names: string[] = []
  for (const seg of segments) {
    const condition = parseJson<ConditionNode>(seg.conditionsJson, { op: 'and', conditions: [] })
    // empty condition => matches everyone (catch-all segment)
    const matches = evaluateCondition(condition, params.context)
    if (matches) {
      ids.push(seg.id)
      names.push(seg.name)
    }
  }
  return { ids, names }
}

/** Feature flag evaluation with rollout percentage + segment targeting. */
export async function evaluateFeatureFlags(params: {
  projectId: string
  environmentId: string
  appUserId: string
  segmentIds: string[]
}): Promise<Record<string, boolean>> {
  const flags = await db.featureFlag.findMany({
    where: { projectId: params.projectId, environmentId: params.environmentId, status: 'active' },
  })

  const result: Record<string, boolean> = {}
  for (const flag of flags) {
    if (!flag.enabled) {
      result[flag.key] = false
      continue
    }
    const targetSegments = parseJson<string[]>(flag.segmentsJson, [])
    if (targetSegments.length > 0 && !targetSegments.some((sid) => params.segmentIds.includes(sid))) {
      result[flag.key] = false
      continue
    }
    if (flag.rolloutPercent >= 100) {
      result[flag.key] = true
      continue
    }
    // deterministic bucketing on (flag:user) seed
    const bucket = deterministicBucket(`${flag.key}:${params.appUserId}`, 100)
    result[flag.key] = bucket < flag.rolloutPercent
  }
  return result
}

/** Experiment assignment: deterministic, sticky per user. */
export async function assignExperiments(params: {
  projectId: string
  environmentId: string
  appUserId: string
}): Promise<Record<string, string>> {
  const experiments = await db.experiment.findMany({
    where: { projectId: params.projectId, environmentId: params.environmentId, status: 'running' },
  })

  const result: Record<string, string> = {}
  for (const exp of experiments) {
    const existing = await db.experimentAssignment.findUnique({
      where: { experimentId_appUserId: { experimentId: exp.id, appUserId: params.appUserId } },
    })
    if (existing) {
      result[exp.key] = existing.variant
      continue
    }
    const variants = parseJson<Array<{ key: string; weight: number }>>(exp.variantsJson, [])
    const totalWeight = variants.reduce((s, v) => s + (v.weight ?? 0), 0)
    if (totalWeight <= 0 || variants.length === 0) continue

    // traffic gate
    const gateBucket = deterministicBucket(`__gate__:${exp.key}:${params.appUserId}`, 100)
    if (gateBucket >= exp.trafficPercent) continue

    const bucket = deterministicBucket(`${exp.key}:${params.appUserId}`, totalWeight)
    let cumulative = 0
    let chosen = variants[0].key
    for (const v of variants) {
      cumulative += v.weight ?? 0
      if (bucket < cumulative) {
        chosen = v.key
        break
      }
    }

    await db.experimentAssignment.create({
      data: { experimentId: exp.id, appUserId: params.appUserId, variant: chosen },
    }).catch(() => null) // race tolerated

    result[exp.key] = chosen
  }
  return result
}

export async function getRemoteConfigs(projectId: string, environmentId: string): Promise<Record<string, unknown>> {
  const configs = await db.remoteConfig.findMany({
    where: { projectId, environmentId, status: 'active' },
  })
  const result: Record<string, unknown> = {}
  for (const c of configs) {
    try {
      result[c.key] = JSON.parse(c.valueJson)
    } catch {
      result[c.key] = c.valueJson
    }
  }
  return result
}
