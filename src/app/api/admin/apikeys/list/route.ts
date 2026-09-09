/**
 * API keys management (Settings) + scope resolution.
 * GET  — list keys (masked)
 * POST — create key (returns full secret ONCE)
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { createApiKey } from '@/server/identity/service'
import { recordAudit } from '@/server/audit/service'
import { parseJson } from '@/server/core/types'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const keys = await db.apiKey.findMany({
      where: { projectId: scope.projectId, environmentId: scope.environmentId },
      orderBy: { createdAt: 'desc' },
    })
    return json({
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.keyPrefix + '...',
        scopes: parseJson<string[]>(k.scopesJson, []),
        status: k.status,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
      })),
      scope,
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const body = await readJson<{ name: string; scopes?: string[] }>(req)
    if (!body.name) {
      return json({ error: { code: 'NAME_REQUIRED', message: 'API key name is required.' } }, 400)
    }
    const created = await createApiKey({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      name: body.name,
      scopes: body.scopes,
    })
    await recordAudit({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      actorType: 'human',
      actorId: admin.adminUserId,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: created.id,
      afterJson: JSON.stringify({ name: created.name, environment: scope.environmentName }),
    })
    return json({ key: created }, 201)
  } catch (e) {
    return apiError(e)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return json({ error: { code: 'ID_REQUIRED', message: 'Query param id required.' } }, 400)
    const key = await db.apiKey.findUnique({ where: { id } })
    if (!key || key.projectId !== scope.projectId) {
      return json({ error: { code: 'NOT_FOUND', message: 'API key not found.' } }, 404)
    }
    await db.apiKey.update({ where: { id }, data: { status: 'revoked' } })
    await recordAudit({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      actorType: 'human',
      actorId: admin.adminUserId,
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: id,
    })
    return json({ revoked: true })
  } catch (e) {
    return apiError(e)
  }
}
