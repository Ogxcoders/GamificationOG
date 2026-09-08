/**
 * GET  /api/admin/[resource]?projectId=&environmentId= — list objects
 * POST /api/admin/[resource] — create (validates schema + semantics, audits)
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { RESOURCES, listOrderBy } from '@/server/admin/resources'
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
      fix: `Available: ${Object.keys(RESOURCES).join(', ')}`,
    })
  }
  return config
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ resource: string }> }) {
  try {
    await requireAdmin(req)
    const { resource } = await params
    const config = resourceConfig(resource)
    const scope = await resolveScope(req)
    const url = new URL(req.url)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000)
    const status = url.searchParams.get('status')

    // @ts-expect-error dynamic prisma delegate access
    const delegate = db[config.delegate] as { findMany: (args: Record<string, unknown>) => Promise<unknown[]> }
    const where: Record<string, unknown> = { projectId: scope.projectId, environmentId: scope.environmentId }
    if (status) where.status = status

    const items = await delegate.findMany({ where, orderBy: listOrderBy(resource), take: limit })
    return json({ items, scope: { projectId: scope.projectId, environmentId: scope.environmentId, projectName: scope.projectName, environmentName: scope.environmentName } })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ resource: string }> }) {
  try {
    const admin = await requireAdmin(req)
    const { resource } = await params
    const config = resourceConfig(resource)
    const scope = await resolveScope(req)
    const body = await readJson<Record<string, unknown>>(req)

    // allowed fields only (config-first, no injection of internal columns)
    const data: Record<string, unknown> = {}
    for (const field of config.fields) {
      if (body[field] !== undefined) data[field] = body[field]
    }
    for (const required of config.requiredOnCreate ?? []) {
      if (data[required] === undefined || data[required] === null || data[required] === '') {
        throw new PlatformError({
          code: 'FIELD_REQUIRED',
          category: 'validation',
          message: `Field "${required}" is required.`,
        })
      }
    }

    await config.validate?.(data, 'create')

    // @ts-expect-error dynamic prisma delegate access
    const delegate = db[config.delegate] as { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
    try {
      const created = await delegate.create({
        data: { ...data, projectId: scope.projectId, environmentId: scope.environmentId },
      })
      await recordAudit({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        actorType: 'human',
        actorId: admin.adminUserId,
        action: `${config.auditType}.created`,
        targetType: config.auditType,
        targetId: (created as { id?: string }).id,
        afterJson: JSON.stringify(created),
      })
      return json({ item: created }, 201)
    } catch (e) {
      if (e instanceof Error && e.message.includes('Unique constraint')) {
        throw new PlatformError({
          code: 'DUPLICATE',
          category: 'conflict',
          message: `An object with the same unique field already exists in this environment. ${config.uniqueOn ? `Unique on: ${config.uniqueOn.join(', ')}` : ''}`,
        })
      }
      throw e
    }
  } catch (e) {
    return apiError(e)
  }
}
