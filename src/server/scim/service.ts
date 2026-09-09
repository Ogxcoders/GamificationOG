/**
 * GamificationOG — SCIM 2.0 provisioning service (§ Phase 5, RFC 7643/7644).
 *
 * Automated admin-directory management driven by the customer's IdP:
 *   Users  -> AdminUser (create / update / activate / deactivate)
 *   Groups -> ProjectAdmin memberships (project access with role)
 *
 * Auth: dedicated SCIM bearer token (hashed at rest, Settings-issued).
 * All mutations are audited with actor "scim".
 */
import { randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'
import { hashSecret, hashPassword } from '@/server/identity/service'
import { recordAudit } from '@/server/audit/service'
import type { AdminUser } from '@prisma/client'

export const SCIM_SCHEMA_CORE = 'urn:ietf:params:scim:schemas:core:2.0'
export const SCIM_SCHEMA_USER = SCIM_SCHEMA_CORE + ':User'
export const SCIM_SCHEMA_GROUP = SCIM_SCHEMA_CORE + ':Group'
export const SCIM_SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
export const SCIM_SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error'
export const SCIM_SCHEMA_SP_CONFIG = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface GeneratedScimToken {
  id: string
  name: string
  token: string // shown once
}

export async function createScimToken(name: string): Promise<GeneratedScimToken> {
  const secret = `gog_scim_${randomBytes(24).toString('hex')}`
  const record = await db.scimToken.create({
    data: {
      name,
      tokenHash: hashSecret(secret),
      tokenPrefix: secret.slice(0, 16),
    },
  })
  return { id: record.id, name: record.name, token: secret }
}

export async function authenticateScimToken(provided: string): Promise<boolean> {
  if (!provided.startsWith('gog_scim_')) return false
  const record = await db.scimToken.findUnique({ where: { tokenHash: hashSecret(provided) } })
  if (!record || record.status !== 'active') return false
  await db.scimToken.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
  return true
}

// ---------------------------------------------------------------------------
// Resource mappers
// ---------------------------------------------------------------------------

const VALID_ROLES = ['owner', 'admin', 'editor', 'viewer']

export function adminToScimUser(u: AdminUser, groups?: Array<{ id: string; displayName: string }>) {
  const resource: Record<string, unknown> = {
    schemas: [SCIM_SCHEMA_USER],
    id: u.id,
    userName: u.email,
    active: u.status === 'active',
    name: {
      formatted: u.name,
      givenName: u.name.split(' ')[0] ?? u.name,
      familyName: u.name.split(' ').slice(1).join(' ') || u.name,
    },
    displayName: u.name,
    emails: [{ value: u.email, primary: true, type: 'work' }],
    roles: [{ value: u.role, primary: true }],
    meta: {
      resourceType: 'User',
      created: u.createdAt.toISOString(),
      lastModified: u.updatedAt.toISOString(),
      location: `/api/scim/v2/Users/${u.id}`,
    },
  }
  if (groups) {
    resource['groups'] = groups.map((g) => ({ value: g.id, display: g.displayName, ref: `/api/scim/v2/Groups/${g.id}` }))
  }
  return resource
}

function scimError(status: number, detail: string) {
  return new PlatformError({
    code: status === 404 ? 'SCIM_NOT_FOUND' : 'SCIM_ERROR',
    category: status === 404 ? 'not_found' : 'validation',
    message: detail,
    status,
    detail,
  })
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface ScimUserListQuery {
  filter?: string
  startIndex: number
  count: number
}

export async function listScimUsers(q: ScimUserListQuery) {
  let where: Record<string, unknown> | undefined
  if (q.filter) {
    const m = q.filter.match(/^(userName|emails\.value|displayName)\s+eq\s+"(.*)"$/i)
    if (!m) {
      throw scimError(400, `Unsupported filter "${q.filter}". Supported: userName eq "…", emails.value eq "…"`)
    }
    const value = m[2].toLowerCase()
    where = m[1] === 'displayName' ? { name: { contains: value } } : { email: value }
  }
  const [total, rows] = await Promise.all([
    db.adminUser.count(where ? { where: where as never } : undefined),
    db.adminUser.findMany({
      where: where as never,
      orderBy: { createdAt: 'asc' },
      skip: Math.max(0, q.startIndex - 1),
      take: Math.min(200, Math.max(1, q.count)),
    }),
  ])
  return {
    schemas: [SCIM_SCHEMA_LIST],
    totalResults: total,
    startIndex: q.startIndex,
    itemsPerPage: rows.length,
    Resources: rows.map((u) => adminToScimUser(u)),
  }
}

export async function getScimUser(id: string) {
  const user = await db.adminUser.findUnique({ where: { id } })
  if (!user) throw scimError(404, `User ${id} not found`)
  const memberships = await db.projectAdmin.findMany({ where: { userId: id }, include: { project: true } })
  return adminToScimUser(
    user,
    memberships.map((m) => ({ id: m.id, displayName: `project:${m.project.slug}:${m.role}` })),
  )
}

export interface ScimUserInput {
  userName: string
  displayName?: string
  active?: boolean
  role?: string
}

export async function createScimUser(input: ScimUserInput) {
  const email = (input.userName ?? '').toLowerCase()
  if (!email || !email.includes('@')) throw scimError(400, 'userName (email) is required')
  const existing = await db.adminUser.findUnique({ where: { email } })
  if (existing) {
    throw new PlatformError({
      code: 'SCIM_CONFLICT',
      category: 'conflict',
      message: `User "${email}" already exists.`,
      status: 409,
    })
  }
  const role = VALID_ROLES.includes(input.role ?? '') ? input.role : 'viewer'
  const user = await db.adminUser.create({
    data: {
      email,
      name: input.displayName ?? email.split('@')[0],
      passwordHash: hashPassword(`scm-${randomBytes(24).toString('hex')}`),
      role,
      status: input.active === false ? 'suspended' : 'active',
    },
  })
  await recordAudit({
    projectId: 'global',
    actorType: 'system',
    actorId: 'scim',
    action: 'scim.user_created',
    targetType: 'admin_user',
    targetId: user.id,
    afterJson: JSON.stringify({ email, role, active: input.active !== false }),
  })
  return adminToScimUser(user)
}

export async function replaceScimUser(id: string, input: ScimUserInput) {
  const user = await db.adminUser.findUnique({ where: { id } })
  if (!user) throw scimError(404, `User ${id} not found`)
  const data: Record<string, unknown> = {}
  if (input.displayName !== undefined) data.name = input.displayName
  if (input.active !== undefined) data.status = input.active ? 'active' : 'suspended'
  if (input.role !== undefined && VALID_ROLES.includes(input.role)) data.role = input.role
  if (input.userName !== undefined) {
    const newEmail = input.userName.toLowerCase()
    if (newEmail !== user.email) {
      const dupe = await db.adminUser.findUnique({ where: { email: newEmail } })
      if (dupe) {
        throw new PlatformError({
          code: 'SCIM_CONFLICT',
          category: 'conflict',
          message: `userName "${newEmail}" is taken.`,
          status: 409,
        })
      }
      data.email = newEmail
    }
  }
  const updated = await db.adminUser.update({ where: { id }, data })
  await recordAudit({
    projectId: 'global',
    actorType: 'system',
    actorId: 'scim',
    action: 'scim.user_replaced',
    targetType: 'admin_user',
    targetId: id,
    beforeJson: JSON.stringify({ email: user.email, status: user.status, role: user.role }),
    afterJson: JSON.stringify({ email: updated.email, status: updated.status, role: updated.role }),
  })
  return adminToScimUser(updated)
}

/** RFC 7644 PATCH: "replace" ops on active / displayName / role (whole-value form supported). */
export async function patchScimUser(id: string, operations: Array<{ op: string; path?: string; value?: unknown }>) {
  const user = await db.adminUser.findUnique({ where: { id } })
  if (!user) throw scimError(404, `User ${id} not found`)
  const data: Record<string, unknown> = {}
  let patchActive: boolean | undefined
  for (const op of operations) {
    if ((op.op ?? '').toLowerCase() !== 'replace') {
      throw scimError(400, `Only "replace" operations are supported (got "${op.op}")`)
    }
    const path = (op.path ?? '').toLowerCase()
    if (path === 'active') {
      patchActive = Boolean(op.value)
    } else if (path.startsWith('emails') || path === 'displayname' || path === 'name.givenname' || path === 'name.familyname') {
      if (path === 'displayname' && typeof op.value === 'string') data.name = op.value
      // email/name-part patches tolerated as no-ops (identity keys owned by the IdP)
    } else if (path === 'role') {
      const role = String(op.value ?? '')
      if (!VALID_ROLES.includes(role)) throw scimError(400, `role "${role}" invalid`)
      data.role = role
    } else if (!path) {
      const v = op.value as Record<string, unknown> | undefined
      if (v && typeof v === 'object') {
        if (v.active !== undefined) patchActive = Boolean(v.active)
        if (typeof v.displayName === 'string') data.name = v.displayName
        if (typeof v.role === 'string' && VALID_ROLES.includes(v.role)) data.role = v.role
      }
    } else {
      throw scimError(400, `Unsupported patch path "${op.path}"`)
    }
  }
  if (patchActive !== undefined) data.status = patchActive ? 'active' : 'suspended'
  const updated = await db.adminUser.update({ where: { id }, data })
  await recordAudit({
    projectId: 'global',
    actorType: 'system',
    actorId: 'scim',
    action: patchActive === false ? 'scim.user_deactivated' : 'scim.user_patched',
    targetType: 'admin_user',
    targetId: id,
    beforeJson: JSON.stringify({ status: user.status, role: user.role, name: user.name }),
    afterJson: JSON.stringify({ status: updated.status, role: updated.role, name: updated.name }),
  })
  return adminToScimUser(updated)
}

/** SCIM delete = deactivate (never hard delete; audit trail + history preserved). */
export async function deleteScimUser(id: string) {
  const user = await db.adminUser.findUnique({ where: { id } })
  if (!user) throw scimError(404, `User ${id} not found`)
  await db.adminUser.update({ where: { id }, data: { status: 'suspended' } })
  await db.adminSession.deleteMany({ where: { userId: id } })
  await recordAudit({
    projectId: 'global',
    actorType: 'system',
    actorId: 'scim',
    action: 'scim.user_deactivated',
    targetType: 'admin_user',
    targetId: id,
    beforeJson: JSON.stringify({ email: user.email, status: user.status }),
  })
}

// ---------------------------------------------------------------------------
// Groups -> ProjectAdmin memberships
// ---------------------------------------------------------------------------

interface GroupRow {
  id: string
  displayName: string
  projectId: string
  role: string
  members: string[]
}

async function loadGroups(): Promise<GroupRow[]> {
  const memberships = await db.projectAdmin.findMany({ include: { project: true, user: true } })
  const byId = new Map<string, GroupRow>()
  for (const m of memberships) {
    let g = byId.get(m.id)
    if (!g) {
      g = { id: m.id, displayName: `project:${m.project.slug}:${m.role}`, projectId: m.projectId, role: m.role, members: [] }
      byId.set(m.id, g)
    }
    g.members.push(m.userId)
  }
  return Array.from(byId.values())
}

function groupResource(g: GroupRow) {
  return {
    schemas: [SCIM_SCHEMA_GROUP],
    id: g.id,
    displayName: g.displayName,
    members: g.members.map((uid) => ({ value: uid, ref: `/api/scim/v2/Users/${uid}` })),
    meta: { resourceType: 'Group', location: `/api/scim/v2/Groups/${g.id}` },
  }
}

export async function listScimGroups(startIndex: number, count: number) {
  const groups = await loadGroups()
  const page = groups.slice(startIndex - 1, startIndex - 1 + Math.min(200, Math.max(1, count)))
  return {
    schemas: [SCIM_SCHEMA_LIST],
    totalResults: groups.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: page.map(groupResource),
  }
}

export async function createScimGroup(input: { displayName: string; members?: Array<{ value: string }> }) {
  // displayName format: project:<slug>:<role>
  const m = (input.displayName ?? '').match(/^project:([^:]+):(owner|admin|editor|viewer)$/)
  if (!m) {
    throw scimError(400, 'Group displayName must be "project:<slug>:<role>" (maps to project access)')
  }
  const [, slug, role] = m
  const project = await db.project.findFirst({ where: { slug } })
  if (!project) throw scimError(404, `Project slug "${slug}" not found`)
  const firstUser = input.members?.[0]?.value
  if (!firstUser) throw scimError(400, 'Group creation requires at least one member (userId)')

  const existing = await db.projectAdmin.findFirst({ where: { projectId: project.id, userId: firstUser } })
  if (existing) {
    const updated = await db.projectAdmin.update({ where: { id: existing.id }, data: { role } })
    await recordAudit({
      projectId: project.id,
      actorType: 'system',
      actorId: 'scim',
      action: 'scim.group_membership_updated',
      targetType: 'project_admin',
      targetId: updated.id,
      afterJson: JSON.stringify({ role, userId: updated.userId }),
    })
    return groupResource({ id: updated.id, displayName: `project:${slug}:${role}`, projectId: project.id, role, members: [updated.userId] })
  }
  const user = await db.adminUser.findUnique({ where: { id: firstUser } })
  if (!user) throw scimError(404, `User ${firstUser} not found`)
  const created = await db.projectAdmin.create({ data: { projectId: project.id, userId: firstUser, role } })
  await recordAudit({
    projectId: project.id,
    actorType: 'system',
    actorId: 'scim',
    action: 'scim.group_created',
    targetType: 'project_admin',
    targetId: created.id,
    afterJson: JSON.stringify({ role, userId: created.userId }),
  })
  return groupResource({ id: created.id, displayName: `project:${slug}:${role}`, projectId: project.id, role, members: [created.userId] })
}

export async function deleteScimGroup(id: string) {
  const existing = await db.projectAdmin.findUnique({ where: { id } })
  if (!existing) throw scimError(404, `Group ${id} not found`)
  await db.projectAdmin.delete({ where: { id } })
  await recordAudit({
    projectId: existing.projectId,
    actorType: 'system',
    actorId: 'scim',
    action: 'scim.group_deleted',
    targetType: 'project_admin',
    targetId: id,
    beforeJson: JSON.stringify({ role: existing.role, userId: existing.userId }),
  })
}

export function serviceProviderConfig() {
  return {
    schemas: [SCIM_SCHEMA_SP_CONFIG],
    documentationUri: 'https://github.com/Ogxcoders/GamificationOG',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'SCIM Bearer Token',
        description: 'Issue a SCIM token in Settings → SCIM Provisioning.',
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: '/api/scim/v2/ServiceProviderConfig' },
  }
}
