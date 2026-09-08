/**
 * GamificationOG — Admin session + scope helpers.
 * Dashboard auth via signed session cookie; project/environment scope
 * selection persisted in a cookie (multi-tenancy aware, Section 8).
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'
import { authenticateAdminSession } from '@/server/identity/service'
import type { AuthenticatedAdmin } from '@/server/core/types'

export const ADMIN_SESSION_COOKIE = 'gog_sid'
export const SCOPE_COOKIE = 'gog_scope'

export async function requireAdmin(req: NextRequest): Promise<AuthenticatedAdmin> {
  const token = req.cookies.get(ADMIN_SESSION_COOKIE)?.value
  if (!token) {
    throw new PlatformError({
      code: 'UNAUTHENTICATED',
      category: 'auth',
      message: 'Dashboard session required. Please log in.',
      status: 401,
    })
  }
  const admin = await authenticateAdminSession(token)
  if (!admin) {
    throw new PlatformError({
      code: 'SESSION_EXPIRED',
      category: 'auth',
      message: 'Session expired or invalid. Please log in again.',
      status: 401,
    })
  }
  return admin
}

export interface AdminScope {
  projectId: string
  environmentId: string
  projectName: string
  environmentName: string
}

export async function resolveScope(req: NextRequest): Promise<AdminScope> {
  const url = new URL(req.url)
  const projectId = url.searchParams.get('projectId')
  const environmentId = url.searchParams.get('environmentId')

  if (projectId && environmentId) {
    const project = await db.project.findUnique({ where: { id: projectId }, include: { environments: true } })
    if (!project) throw new PlatformError({ code: 'PROJECT_NOT_FOUND', category: 'not_found', message: 'Project not found.' })
    const env = project.environments.find((e) => e.id === environmentId)
    if (!env) throw new PlatformError({ code: 'ENVIRONMENT_NOT_FOUND', category: 'not_found', message: 'Environment not found.' })
    return { projectId, environmentId, projectName: project.name, environmentName: env.name }
  }

  // fall back to scope cookie
  const scopeCookie = req.cookies.get(SCOPE_COOKIE)?.value
  if (scopeCookie) {
    try {
      const parsed = JSON.parse(decodeURIComponent(scopeCookie)) as { projectId: string; environmentId: string }
      const project = await db.project.findUnique({ where: { id: parsed.projectId }, include: { environments: true } })
      const env = project?.environments.find((e) => e.id === parsed.environmentId)
      if (project && env) {
        return { projectId: project.id, environmentId: env.id, projectName: project.name, environmentName: env.name }
      }
    } catch {
      // invalid cookie, continue to default
    }
  }

  // default: first project, development env
  const { getDashboardScope } = await import('@/server/tenancy/service')
  const scope = await getDashboardScope()
  if (!scope) {
    throw new PlatformError({
      code: 'NO_PROJECT',
      category: 'not_found',
      message: 'No projects exist yet. Seed the demo project or create one.',
      fix: 'Run `bun run seed` or create a project in Setup.',
    })
  }
  return {
    projectId: scope.project.id,
    environmentId: scope.environment.id,
    projectName: scope.project.name,
    environmentName: scope.environment.name,
  }
}

export async function hasAnyAdmin(): Promise<boolean> {
  const count = await db.adminUser.count()
  return count > 0
}
