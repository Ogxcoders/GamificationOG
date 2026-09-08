/**
 * GET  /api/admin/scope — resolve dashboard scope (org/workspace/project/env).
 * POST /api/admin/scope — switch project/environment (sets scope cookie).
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { requireAdmin, resolveScope, SCOPE_COOKIE } from '@/lib/admin-auth'
import { getDashboardScope } from '@/server/tenancy/service'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req).catch(() => null)
    const full = await getDashboardScope()
    // all projects for the switcher
    const projects = await db.project.findMany({
      include: { environments: { orderBy: { name: 'asc' } }, workspace: { include: { organization: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return json({
      scope: scope
        ? { ...scope, environments: full?.environments ?? [] }
        : null,
      organizations: projects.reduce<Record<string, { name: string; workspaces: Record<string, { name: string; projects: Array<{ id: string; name: string; environments: Array<{ id: string; name: string }> }> }> }>>((acc, p) => {
        const orgName = p.workspace.organization.name
        const wsName = p.workspace.name
        acc[orgName] ??= { name: orgName, workspaces: {} }
        acc[orgName].workspaces[wsName] ??= { name: wsName, projects: [] }
        acc[orgName].workspaces[wsName].projects.push({
          id: p.id,
          name: p.name,
          environments: p.environments.map((e) => ({ id: e.id, name: e.name })),
        })
        return acc
      }, {}),
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req)
    const body = await readJson<{ projectId: string; environmentId: string }>(req)
    const project = await db.project.findUnique({
      where: { id: body.projectId },
      include: { environments: true },
    })
    if (!project) return json({ error: { code: 'NOT_FOUND', message: 'Project not found.' } }, 404)
    const env = project.environments.find((e) => e.id === body.environmentId)
    if (!env) return json({ error: { code: 'NOT_FOUND', message: 'Environment not found.' } }, 404)

    const res = json({ ok: true, scope: { projectId: project.id, environmentId: env.id } })
    res.cookies.set(SCOPE_COOKIE, encodeURIComponent(JSON.stringify({ projectId: project.id, environmentId: env.id })), {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 86400,
    })
    return res
  } catch (e) {
    return apiError(e)
  }
}
