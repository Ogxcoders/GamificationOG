/**
 * GET    /api/admin/[resource]/[id] — fetch one
 * PATCH  /api/admin/[resource]/[id] — update (validate + audit before/after)
 * DELETE /api/admin/[resource]/[id] — soft archive (hard delete only for drafts)
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { RESOURCES } from '@/server/admin/resources'
import { recordAudit } from '@/server/audit/service'
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'

function resourceConfig(resource: string) {
  const config = RESOURCES[resource]
  if (!config) {
    throw new PlatformError({
      code: 'UNKNOWN_RESOURCE',
      category: 'not_found',
      message: `Unknown admin resource "${resource}".`,
    })
  }
  return config
}

type Delegate = {
  findUnique: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown> | null>
  update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<Record<string, unknown>>
  delete: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown>>
}

function getDelegate(resource: string): Delegate {
  const config = RESOURCES[resource]
  return db[config.delegate] as unknown as Delegate
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ resource: string; id: string }> }) {
  try {
    await requireAdmin(req)
    const { resource, id } = await params
    const config = resourceConfig(resource)
    const scope = await resolveScope(req)
    const item = await getDelegate(resource).findUnique({ where: { id } })
    if (!item || (item as { projectId?: string }).projectId !== scope.projectId) {
      throw new PlatformError({ code: 'NOT_FOUND', category: 'not_found', message: 'Object not found in this project.' })
    }
    return json({ item })
  } catch (e) {
    return apiError(e)
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ resource: string; id: string }> }) {
  try {
    const admin = await requireAdmin(req)
    const { resource, id } = await params
    const config = resourceConfig(resource)
    const scope = await resolveScope(req)
    const body = await readJson<Record<string, unknown>>(req)

    const delegate = getDelegate(resource)
    const existing = await delegate.findUnique({ where: { id } })
    if (!existing || (existing as { projectId?: string }).projectId !== scope.projectId) {
      throw new PlatformError({ code: 'NOT_FOUND', category: 'not_found', message: 'Object not found in this project.' })
    }

    const data: Record<string, unknown> = {}
    for (const field of config.fields) {
      if (body[field] !== undefined) data[field] = body[field]
    }
    await config.validate?.(data, 'update')

    const updated = await delegate.update({ where: { id }, data })
    await recordAudit({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      actorType: 'human',
      actorId: admin.adminUserId,
      action: `${config.auditType}.updated`,
      targetType: config.auditType,
      targetId: id,
      beforeJson: JSON.stringify(existing),
      afterJson: JSON.stringify(updated),
    })
    return json({ item: updated })
  } catch (e) {
    return apiError(e)
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ resource: string; id: string }> }) {
  try {
    const admin = await requireAdmin(req)
    const { resource, id } = await params
    const config = resourceConfig(resource)
    const scope = await resolveScope(req)

    const delegate = getDelegate(resource)
    const existing = await delegate.findUnique({ where: { id } })
    if (!existing || (existing as { projectId?: string }).projectId !== scope.projectId) {
      throw new PlatformError({ code: 'NOT_FOUND', category: 'not_found', message: 'Object not found in this project.' })
    }

    const status = (existing as { status?: string }).status ?? 'active'
    if (status === 'active' || status === 'published') {
      // Invariant: no silent mutation of production objects — archive instead
      const updated = await delegate.update({ where: { id }, data: { status: 'archived' } })
      await recordAudit({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        actorType: 'human',
        actorId: admin.adminUserId,
        action: `${config.auditType}.archived`,
        targetType: config.auditType,
        targetId: id,
        beforeJson: JSON.stringify(existing),
        afterJson: JSON.stringify(updated),
      })
      return json({ archived: true, item: updated })
    }

    await delegate.delete({ where: { id } })
    await recordAudit({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      actorType: 'human',
      actorId: admin.adminUserId,
      action: `${config.auditType}.deleted`,
      targetType: config.auditType,
      targetId: id,
      beforeJson: JSON.stringify(existing),
    })
    return json({ deleted: true })
  } catch (e) {
    return apiError(e)
  }
}
