/**
 * GamificationOG — Tenancy Service (Section 8)
 * Organization > Workspace > Project > Environment. Tenant, workspace,
 * project and environment isolation are explicit at every boundary.
 */
import { db } from '@/lib/db'
import { PlatformError } from '../core/errors'

export const DEFAULT_ENVIRONMENTS = ['development', 'staging', 'production']

export async function createOrganization(params: { name: string; slug?: string }) {
  const slug = (params.slug ?? slugify(params.name)) + '-' + randomSuffix()
  return db.organization.create({
    data: {
      name: params.name,
      slug,
      workspaces: {
        create: {
          name: 'Default Workspace',
          slug: 'default',
          projects: {
            create: {
              name: 'My First Project',
              slug: 'my-first-project',
              environments: {
                create: DEFAULT_ENVIRONMENTS.map((name) => ({ name })),
              },
            },
          },
        },
      },
    },
    include: { workspaces: { include: { projects: { include: { environments: true } } } } },
  })
}

export async function createProject(params: {
  workspaceId: string
  name: string
  description?: string
  timezone?: string
}) {
  return db.project.create({
    data: {
      workspaceId: params.workspaceId,
      name: params.name,
      slug: slugify(params.name) + '-' + randomSuffix(),
      description: params.description ?? null,
      timezone: params.timezone ?? 'UTC',
      environments: {
        create: DEFAULT_ENVIRONMENTS.map((name) => ({ name })),
      },
    },
    include: { environments: true },
  })
}

export async function getProjectContext(projectId: string, environmentName: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { workspace: true, environments: true },
  })
  if (!project) {
    throw new PlatformError({
      code: 'PROJECT_NOT_FOUND',
      category: 'not_found',
      message: `Project "${projectId}" does not exist.`,
    })
  }
  const environment = project.environments.find((e) => e.name === environmentName)
  if (!environment) {
    throw new PlatformError({
      code: 'ENVIRONMENT_NOT_FOUND',
      category: 'not_found',
      message: `Environment "${environmentName}" not found on project "${project.name}".`,
      fix: `Available: ${project.environments.map((e) => e.name).join(', ')}`,
    })
  }
  return { project, environment }
}

export async function getFirstProjectWithEnv() {
  const org = await db.organization.findFirst({
    include: {
      workspaces: {
        include: {
          projects: {
            orderBy: { createdAt: 'asc' },
            include: { environments: { orderBy: { name: 'asc' } } },
          },
        },
      },
    },
  })
  if (!org) return null
  const workspace = org.workspaces[0]
  const project = workspace?.projects[0]
  if (!project) return null
  const environment = project.environments.find((e) => e.name === 'development') ?? project.environments[0]
  return { organization: org, workspace, project, environment }
}

export async function getDashboardScope() {
  const scope = await getFirstProjectWithEnv()
  if (!scope) return null
  return {
    organization: { id: scope.organization.id, name: scope.organization.name },
    workspace: { id: scope.workspace.id, name: scope.workspace.name },
    project: { id: scope.project.id, name: scope.project.name, slug: scope.project.slug, timezone: scope.project.timezone },
    environment: { id: scope.environment.id, name: scope.environment.name },
    environments: scope.project.environments.map((e) => ({ id: e.id, name: e.name })),
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}
