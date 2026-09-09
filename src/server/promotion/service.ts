/**
 * GamificationOG — Environment promotion (§ Mode C, Phase 5).
 *
 * Promotes the gamification configuration of one environment into another
 * (development → staging → production) inside the same project, reusing the
 * battle-tested export/import pipeline:
 *
 *   export(source env)  →  preview/apply into target env with "overwrite"
 *
 * Safety properties inherited from the importer:
 *  - natural-keyed diff (only changed objects are touched)
 *  - per-object semantic validation (same code path as manual creation)
 *  - transactional apply (all or nothing)
 *  - audit lineage (environment.promoted with counts + manifest reference)
 */
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'
import { exportGamificationSystem } from '@/server/io/exporter'
import { applyImport, previewImport } from '@/server/io/importer'
import { recordAudit } from '@/server/audit/service'

export interface PromoteParams {
  projectId: string
  fromEnvironment: string // environment name (development | staging | production)
  toEnvironment: string
  dryRun: boolean
  actorId: string
}

export interface PromoteResult {
  dryRun: boolean
  from: string
  to: string
  summary: { create: number; overwrite: number; skip: number; identical: number }
  objects: Array<{ resource: string; naturalKey: string; action: string; reason?: string }>
  applied: boolean
}

async function resolveEnvironment(projectId: string, name: string) {
  const env = await db.environment.findFirst({ where: { projectId, name } })
  if (!env) {
    const names = await db.environment.findMany({ where: { projectId }, select: { name: true } })
    throw new PlatformError({
      code: 'ENVIRONMENT_NOT_FOUND',
      category: 'not_found',
      message: `Environment "${name}" does not exist in this project.`,
      status: 404,
      fix: `Available environments: ${names.map((n) => n.name).join(', ') || '(none)'}.`,
    })
  }
  return env
}

export async function promoteEnvironment(params: PromoteParams): Promise<PromoteResult> {
  if (params.fromEnvironment === params.toEnvironment) {
    throw new PlatformError({
      code: 'PROMOTE_SELF',
      category: 'validation',
      message: 'Source and target environments must differ.',
    })
  }
  const [fromEnv, toEnv] = await Promise.all([
    resolveEnvironment(params.projectId, params.fromEnvironment),
    resolveEnvironment(params.projectId, params.toEnvironment),
  ])
  const project = await db.project.findUnique({ where: { id: params.projectId } })
  if (!project) throw new PlatformError({ code: 'PROJECT_NOT_FOUND', category: 'not_found', message: 'Project not found.', status: 404 })

  // 1. export the source environment configuration
  const pkg = await exportGamificationSystem({
    projectId: params.projectId,
    environmentId: fromEnv.id,
    projectName: project.name,
    environmentName: fromEnv.name,
  })

  // 2. plan the apply against the target environment (overwrite strategy)
  const targetScope = { projectId: params.projectId, environmentId: toEnv.id }

  if (params.dryRun) {
    const preview = await previewImport(pkg, targetScope, 'overwrite')
    return {
      dryRun: true,
      from: fromEnv.name,
      to: toEnv.name,
      summary: preview.summary,
      objects: preview.objects.map((o) => ({
        resource: o.resource,
        naturalKey: o.naturalKey,
        action: o.action,
        reason: o.reason,
      })),
      applied: false,
    }
  }

  const result = await applyImport(pkg, targetScope, 'overwrite', params.actorId)
  await recordAudit({
    projectId: params.projectId,
    environmentId: toEnv.id,
    actorType: 'human',
    actorId: params.actorId,
    action: 'environment.promoted',
    targetType: 'environment',
    targetId: toEnv.id,
    beforeJson: JSON.stringify({ from: fromEnv.name, to: toEnv.name }),
    afterJson: JSON.stringify({
      from: fromEnv.name,
      to: toEnv.name,
      summary: result.summary,
      exportedAt: pkg.manifest.exportedAt,
    }),
  })
  return {
    dryRun: false,
    from: fromEnv.name,
    to: toEnv.name,
    summary: result.summary,
    objects: result.objects.map((o) => ({
      resource: o.resource,
      naturalKey: o.naturalKey,
      action: o.action,
      reason: o.reason,
    })),
    applied: result.applied,
  }
}
