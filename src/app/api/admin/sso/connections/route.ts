/**
 * Admin SSO connection management.
 * GET    — list connections (client secret masked)
 * POST   — create (validates discovery on request; secret encrypted at rest)
 * DELETE — remove by ?id=
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { requireAdmin } from '@/lib/admin-auth'
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'
import { recordAudit } from '@/server/audit/service'
import { encryptSecret, discoverEndpoints } from '@/server/sso/oidc'
import { parseJson } from '@/server/core/types'

function mask(conn: { clientSecret: string }) {
  return conn.clientSecret.startsWith('v1.') ? '•••••• (encrypted)' : '••••••'
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const connections = await db.ssoConnection.findMany({ orderBy: { createdAt: 'asc' } })
    return json({
      connections: connections.map((c) => ({
        id: c.id,
        name: c.name,
        issuer: c.issuer,
        clientId: c.clientId,
        clientSecretMasked: mask(c),
        scopes: parseJson<string[]>(c.scopesJson, []),
        domains: parseJson<string[]>(c.domainsJson, []),
        jitEnabled: c.jitEnabled,
        jitRole: c.jitRole,
        status: c.status,
        createdAt: c.createdAt,
      })),
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const body = await readJson<{
      name: string
      issuer: string
      clientId: string
      clientSecret: string
      scopes?: string[]
      domains?: string[]
      jitEnabled?: boolean
      jitRole?: string
      validateDiscovery?: boolean
    }>(req)

    if (!body.name || !body.issuer || !body.clientId || !body.clientSecret) {
      throw new PlatformError({
        code: 'FIELDS_REQUIRED',
        category: 'validation',
        message: 'name, issuer, clientId and clientSecret are required.',
      })
    }
    const issuer = body.issuer.replace(/\/$/, '')
    if (!/^https?:\/\//.test(issuer)) {
      throw new PlatformError({
        code: 'ISSUER_INVALID',
        category: 'validation',
        message: 'issuer must be an absolute http(s) URL.',
      })
    }
    const jitRole = body.jitRole ?? 'viewer'
    if (!['owner', 'admin', 'editor', 'viewer'].includes(jitRole)) {
      throw new PlatformError({
        code: 'ROLE_INVALID',
        category: 'validation',
        message: 'jitRole must be one of owner | admin | editor | viewer.',
      })
    }

    // discovery validation (default on) — catches bad issuers at config time
    let discovery: Awaited<ReturnType<typeof discoverEndpoints>> | null = null
    if (body.validateDiscovery !== false) {
      discovery = await discoverEndpoints(issuer)
    }

    const created = await db.ssoConnection.create({
      data: {
        name: body.name,
        issuer,
        clientId: body.clientId,
        clientSecret: encryptSecret(body.clientSecret),
        scopesJson: JSON.stringify(body.scopes ?? ['openid', 'email', 'profile']),
        domainsJson: JSON.stringify(body.domains ?? []),
        jitEnabled: body.jitEnabled ?? true,
        jitRole,
      },
    })
    await recordAudit({
      projectId: 'global',
      actorType: 'human',
      actorId: admin.adminUserId,
      action: 'sso.connection_created',
      targetType: 'sso_connection',
      targetId: created.id,
      afterJson: JSON.stringify({ name: created.name, issuer, jitRole, jitEnabled: created.jitEnabled }),
    })
    return json(
      {
        connection: {
          id: created.id,
          name: created.name,
          issuer: created.issuer,
          status: created.status,
          jitRole: created.jitRole,
        },
        discovery: discovery
          ? {
              ok: true,
              authorization_endpoint: discovery.authorization_endpoint,
              token_endpoint: discovery.token_endpoint,
              userinfo_endpoint: discovery.userinfo_endpoint,
            }
          : { ok: true, skipped: true },
      },
      201,
    )
  } catch (e) {
    return apiError(e)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) throw new PlatformError({ code: 'ID_REQUIRED', category: 'validation', message: 'Query param id required.' })
    const existing = await db.ssoConnection.findUnique({ where: { id } })
    if (!existing) throw new PlatformError({ code: 'NOT_FOUND', category: 'not_found', message: 'SSO connection not found.', status: 404 })
    await db.ssoConnection.delete({ where: { id } })
    await db.ssoFlowState.deleteMany({ where: { connectionId: id } })
    await recordAudit({
      projectId: 'global',
      actorType: 'human',
      actorId: admin.adminUserId,
      action: 'sso.connection_deleted',
      targetType: 'sso_connection',
      targetId: id,
      beforeJson: JSON.stringify({ name: existing.name, issuer: existing.issuer }),
    })
    return json({ deleted: true })
  } catch (e) {
    return apiError(e)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const id = new URL(req.url).searchParams.get('id')
    if (!id) throw new PlatformError({ code: 'ID_REQUIRED', category: 'validation', message: 'Query param id required.' })
    const body = await readJson<{
      status?: string
      jitEnabled?: boolean
      jitRole?: string
      name?: string
      clientSecret?: string
    }>(req)
    const existing = await db.ssoConnection.findUnique({ where: { id } })
    if (!existing) throw new PlatformError({ code: 'NOT_FOUND', category: 'not_found', message: 'SSO connection not found.', status: 404 })
    const data: Record<string, unknown> = {}
    if (body.status) {
      if (!['active', 'disabled'].includes(body.status)) {
        throw new PlatformError({ code: 'STATUS_INVALID', category: 'validation', message: 'status must be active | disabled.' })
      }
      data.status = body.status
    }
    if (body.jitEnabled !== undefined) data.jitEnabled = body.jitEnabled
    if (body.jitRole) {
      if (!['owner', 'admin', 'editor', 'viewer'].includes(body.jitRole)) {
        throw new PlatformError({ code: 'ROLE_INVALID', category: 'validation', message: 'jitRole must be owner | admin | editor | viewer.' })
      }
      data.jitRole = body.jitRole
    }
    if (body.name) data.name = body.name
    if (body.clientSecret) data.clientSecret = encryptSecret(body.clientSecret)
    await db.ssoConnection.update({ where: { id }, data })
    await recordAudit({
      projectId: 'global',
      actorType: 'human',
      actorId: admin.adminUserId,
      action: 'sso.connection_updated',
      targetType: 'sso_connection',
      targetId: id,
      afterJson: JSON.stringify({ fields: Object.keys(data) }),
    })
    return json({ updated: true })
  } catch (e) {
    return apiError(e)
  }
}
