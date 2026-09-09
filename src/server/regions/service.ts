/**
 * GamificationOG — Regions & data residency (§ Phase 5).
 *
 * Logical regions with per-region residency policies. Projects pin to a
 * region; strict policies reject traffic whose asserted user region does
 * not match the project's data region (residency enforcement at the edge
 * of the pipeline, before state is written).
 *
 * In a multi-region deployment each region runs its own instance and
 * database; this module enforces the contract that makes that topology
 * safe (pinning + rejection + reporting), independent of where data lives.
 */
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'
import { parseJson } from '@/server/core/types'
import { recordAudit } from '@/server/audit/service'

export interface ResidencyPolicy {
  enforcement: 'none' | 'strict' | 'tag'
  description?: string
}

export const DEFAULT_REGIONS: Array<{ code: string; name: string; policy: ResidencyPolicy }> = [
  { code: 'global', name: 'Global (no residency constraint)', policy: { enforcement: 'none', description: 'Default region; no residency enforcement.' } },
  { code: 'eu', name: 'European Union (GDPR residency)', policy: { enforcement: 'strict', description: 'Rejects traffic asserting a non-EU region for EU-pinned projects.' } },
  { code: 'us', name: 'United States', policy: { enforcement: 'strict', description: 'Rejects traffic asserting a non-US region for US-pinned projects.' } },
  { code: 'apac', name: 'Asia-Pacific', policy: { enforcement: 'tag', description: 'Tags cross-region traffic; no rejection (soft policy).' } },
]

export async function ensureDefaultRegions() {
  const existing = await db.region.count()
  if (existing > 0) return
  for (const r of DEFAULT_REGIONS) {
    await db.region.upsert({
      where: { code: r.code },
      create: { code: r.code, name: r.name, policyJson: JSON.stringify(r.policy) },
      update: {},
    })
  }
}

export async function listRegions() {
  await ensureDefaultRegions()
  const regions = await db.region.findMany({ orderBy: { code: 'asc' } })
  return regions.map((r) => ({
    code: r.code,
    name: r.name,
    policy: parseJson<ResidencyPolicy>(r.policyJson, { enforcement: 'none' }),
    status: r.status,
    projects: 0, // filled by callers with project counts when needed
  }))
}

export async function getRegionPolicy(code: string): Promise<ResidencyPolicy> {
  const region = await db.region.findUnique({ where: { code } })
  if (!region) return { enforcement: 'none' }
  return parseJson<ResidencyPolicy>(region.policyJson, { enforcement: 'none' })
}

/**
 * Resolve a project's data region (Project.dataRegion, default "global").
 */
export async function getProjectDataRegion(projectId: string): Promise<string> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { dataRegion: true } })
  return project?.dataRegion ?? 'global'
}

export interface ResidencyDecision {
  ok: boolean
  mode: 'none' | 'strict' | 'tag'
  projectRegion: string
  userRegion: string
  tag?: string
  reason?: string
}

/**
 * Enforce residency for an inbound request.
 * - userRegion: asserted via event/identify payload `region` attribute
 *   (or the `x-gog-region` header at the API layer).
 * - 'none': allow everything.
 * - 'strict': allow only when regions match (or the user asserts nothing).
 * - 'tag': allow, but record a cross-region tag.
 */
export async function enforceResidency(params: {
  projectId: string
  userRegion?: string | null
}): Promise<ResidencyDecision> {
  const projectRegion = await getProjectDataRegion(params.projectId)
  const policy = await getRegionPolicy(projectRegion)
  const userRegion = (params.userRegion ?? '').trim().toLowerCase() || 'global'

  if (policy.enforcement === 'none' || projectRegion === 'global') {
    return { ok: true, mode: 'none', projectRegion, userRegion }
  }
  if (policy.enforcement === 'tag') {
    if (userRegion !== 'global' && userRegion !== projectRegion) {
      return {
        ok: true,
        mode: 'tag',
        projectRegion,
        userRegion,
        tag: `cross-region:${userRegion}->${projectRegion}`,
      }
    }
    return { ok: true, mode: 'tag', projectRegion, userRegion }
  }
  // strict
  if (userRegion === projectRegion || userRegion === 'global') {
    return { ok: true, mode: 'strict', projectRegion, userRegion }
  }
  return {
    ok: false,
    mode: 'strict',
    projectRegion,
    userRegion,
    reason: `Project data region "${projectRegion}" (strict residency) cannot accept traffic asserted as region "${userRegion}".`,
  }
}

/** Extract asserted region from payload attributes or header. */
export function assertedRegion(payload: Record<string, unknown>, headerRegion?: string | null): string | undefined {
  if (headerRegion && headerRegion.trim()) return headerRegion.trim().toLowerCase()
  const candidate = (payload as Record<string, unknown>).region ?? (payload as Record<string, unknown>).data_region
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().toLowerCase()
  return undefined
}

export async function setProjectDataRegion(params: {
  projectId: string
  region: string
  actorId: string
}) {
  const region = params.region.toLowerCase()
  await ensureDefaultRegions()
  const record = await db.region.findUnique({ where: { code: region } })
  if (!record || record.status !== 'active') {
    throw new PlatformError({
      code: 'REGION_NOT_FOUND',
      category: 'not_found',
      message: `Region "${region}" is not a registered region.`,
      fix: 'List regions via GET /api/admin/regions and use one of their codes.',
      status: 404,
    })
  }
  const project = await db.project.findUnique({ where: { id: params.projectId } })
  if (!project) {
    throw new PlatformError({ code: 'PROJECT_NOT_FOUND', category: 'not_found', message: 'Project not found.', status: 404 })
  }
  const before = project.dataRegion
  await db.project.update({ where: { id: params.projectId }, data: { dataRegion: region } })
  await recordAudit({
    projectId: params.projectId,
    actorType: 'human',
    actorId: params.actorId,
    action: 'region.project_pinned',
    targetType: 'project',
    targetId: params.projectId,
    beforeJson: JSON.stringify({ dataRegion: before }),
    afterJson: JSON.stringify({ dataRegion: region }),
  })
  return { projectId: params.projectId, dataRegion: region, previous: before }
}

/** Region distribution report (for the analytics summary + admin regions UI). */
export async function regionReport() {
  await ensureDefaultRegions()
  const [regions, projects] = await Promise.all([
    db.region.findMany({ orderBy: { code: 'asc' } }),
    db.project.findMany({ select: { dataRegion: true } }),
  ])
  const byCode = new Map<string, number>()
  for (const p of projects) byCode.set(p.dataRegion ?? 'global', (byCode.get(p.dataRegion ?? 'global') ?? 0) + 1)
  return {
    regions: regions.map((r) => ({
      code: r.code,
      name: r.name,
      policy: parseJson<ResidencyPolicy>(r.policyJson, { enforcement: 'none' }),
      status: r.status,
      projectCount: byCode.get(r.code) ?? 0,
    })),
    unpinned: byCode.get('global') ?? 0,
  }
}
