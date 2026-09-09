/**
 * SCIM token management (Settings).
 * GET    — list tokens (masked)
 * POST   — issue token (full secret returned ONCE)
 * DELETE — revoke by ?id=
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { requireAdmin } from '@/lib/admin-auth'
import { db } from '@/lib/db'
import { createScimToken } from '@/server/scim/service'
import { recordAudit } from '@/server/audit/service'
import { PlatformError } from '@/server/core/errors'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const tokens = await db.scimToken.findMany({ orderBy: { createdAt: 'desc' } })
    return json({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.tokenPrefix + '...',
        status: t.status,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
      })),
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const body = await readJson<{ name: string }>(req)
    if (!body.name) {
      throw new PlatformError({ code: 'NAME_REQUIRED', category: 'validation', message: 'Token name is required.' })
    }
    const created = await createScimToken(body.name)
    await recordAudit({
      projectId: 'global',
      actorType: 'human',
      actorId: admin.adminUserId,
      action: 'scim.token_created',
      targetType: 'scim_token',
      targetId: created.id,
      afterJson: JSON.stringify({ name: created.name }),
    })
    return json({ token: created }, 201)
  } catch (e) {
    return apiError(e)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) throw new PlatformError({ code: 'ID_REQUIRED', category: 'validation', message: 'Query param id required.' })
    const existing = await db.scimToken.findUnique({ where: { id } })
    if (!existing) throw new PlatformError({ code: 'NOT_FOUND', category: 'not_found', message: 'SCIM token not found.', status: 404 })
    await db.scimToken.update({ where: { id }, data: { status: 'revoked' } })
    await recordAudit({
      projectId: 'global',
      actorType: 'human',
      actorId: admin.adminUserId,
      action: 'scim.token_revoked',
      targetType: 'scim_token',
      targetId: id,
    })
    return json({ revoked: true })
  } catch (e) {
    return apiError(e)
  }
}
