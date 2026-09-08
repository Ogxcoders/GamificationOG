/**
 * GamificationOG — Audit Service (Section 96)
 * Immutable audit records: who / what / when / where / before / after /
 * reason / source / request_id / actor_type.
 */
import { db } from '@/lib/db'
import type { ActorType } from '../core/types'

export interface AuditInput {
  projectId: string
  environmentId?: string | null
  actorType: ActorType
  actorId?: string | null
  action: string
  targetType: string
  targetId?: string | null
  beforeJson?: string | null
  afterJson?: string | null
  reason?: string | null
  requestId?: string | null
}

export async function recordAudit(input: AuditInput) {
  return db.auditLog.create({
    data: {
      projectId: input.projectId,
      environmentId: input.environmentId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      beforeJson: input.beforeJson ?? null,
      afterJson: input.afterJson ?? null,
      reason: input.reason ?? null,
      requestId: input.requestId ?? null,
    },
  })
}

export async function getAuditLog(projectId: string, options: { limit?: number; targetType?: string } = {}) {
  return db.auditLog.findMany({
    where: options.targetType ? { projectId, targetType: options.targetType } : { projectId },
    orderBy: { createdAt: 'desc' },
    take: options.limit ?? 100,
  })
}
