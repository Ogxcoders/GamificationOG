/**
 * GamificationOG — Plugin lifecycle service (§54, §110-112).
 *
 * install → enable → disable → uninstall with manifest validation,
 * permission allowlisting, platform-version guards, per-project install
 * records, audit lineage, and EventSchema registration for plugin events.
 */
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'
import { recordAudit } from '@/server/audit/service'
import { validatePluginManifest } from './manifest'
import { findPluginModule, PLUGIN_CATALOG } from './catalog'
import { unregisterActionsByPlugin } from '@/server/engine/actions'

export interface PluginInstallState {
  pluginId: string
  version: string
  status: string
  settingsJson: string
  installedAt?: Date
}

export async function listPluginsWithState(projectId: string, environmentId: string) {
  const installs = await db.pluginInstall.findMany({
    where: { projectId, environmentId, status: { not: 'uninstalled' } },
  })
  const byId = new Map(installs.map((i) => [i.pluginId, i]))
  return PLUGIN_CATALOG.map((module) => {
    const manifest = module.manifest
    const install = byId.get(manifest.id)
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      trust: manifest.trust,
      requires: manifest.requires,
      provides: manifest.provides,
      permissions: manifest.permissions,
      actions: manifest.actions,
      events: manifest.events,
      installed: !!install,
      status: install?.status ?? null,
      installedAt: install?.installedAt ?? null,
    }
  })
}

export async function installPlugin(params: {
  pluginId: string
  projectId: string
  environmentId: string
  adminUserId: string
}) {
  const module = findPluginModule(params.pluginId)
  if (!module) {
    throw new PlatformError({
      code: 'PLUGIN_NOT_FOUND',
      category: 'not_found',
      message: `Plugin "${params.pluginId}" is not in the marketplace catalog.`,
      status: 404,
    })
  }
  // machine-validate the manifest (§112) — re-checks permissions, versions, shapes
  validatePluginManifest(module.manifest)
  // untrusted plugins require explicit confirmation
  if (module.manifest.trust === 'untrusted') {
    throw new PlatformError({
      code: 'PLUGIN_UNTRUSTED',
      category: 'validation',
      message: `Plugin "${params.pluginId}" is untrusted (§56) — installation is blocked by policy.`,
      fix: 'Only first-party/verified/trusted plugins can be installed on this platform build.',
    })
  }

  const existing = await db.pluginInstall.findUnique({
    where: {
      pluginId_projectId_environmentId: {
        pluginId: params.pluginId,
        projectId: params.projectId,
        environmentId: params.environmentId,
      },
    },
  })
  if (existing && existing.status !== 'uninstalled') {
    throw new PlatformError({
      code: 'PLUGIN_ALREADY_INSTALLED',
      category: 'conflict',
      message: `Plugin "${params.pluginId}" is already installed (${existing.status}).`,
      status: 409,
    })
  }

  const record = await db.pluginInstall.upsert({
    where: {
      pluginId_projectId_environmentId: {
        pluginId: params.pluginId,
        projectId: params.projectId,
        environmentId: params.environmentId,
      },
    },
    create: {
      pluginId: params.pluginId,
      version: module.manifest.version,
      projectId: params.projectId,
      environmentId: params.environmentId,
      status: 'enabled',
      installedById: params.adminUserId,
    },
    update: {
      status: 'enabled',
      version: module.manifest.version,
      installedById: params.adminUserId,
      installedAt: new Date(),
    },
  })

  // runtime + schema registration
  await enablePluginRuntime(params.pluginId, params.projectId)

  await recordAudit({
    projectId: params.projectId,
    environmentId: params.environmentId,
    actorType: 'human',
    actorId: params.adminUserId,
    action: 'plugin.installed',
    targetType: 'plugin',
    targetId: params.pluginId,
    afterJson: JSON.stringify({ version: module.manifest.version, status: record.status, trust: module.manifest.trust }),
  })
  return { pluginId: params.pluginId, version: module.manifest.version, status: record.status }
}

/** Register runtime capabilities: engine actions + project event schemas. */
async function enablePluginRuntime(pluginId: string, projectId: string) {
  const module = findPluginModule(pluginId)
  if (!module) return
  // 1. register custom actions into the live engine registry
  await module.register({ projectId, environmentId: '' })
  // 2. upsert EventSchema rows so events validate + rules can target them
  for (const evt of module.manifest.events) {
    await db.eventSchema.upsert({
      where: {
        projectId_name_version: { projectId, name: evt.name, version: evt.version },
      },
      create: {
        projectId,
        name: evt.name,
        version: evt.version,
        description: evt.description ?? `Plugin event (${pluginId})`,
        payloadSchemaJson: JSON.stringify(evt.payloadSchema ?? {}),
        status: 'active',
      },
      update: { status: 'active', description: evt.description ?? `Plugin event (${pluginId})` },
    })
  }
}

export async function setPluginStatus(params: {
  pluginId: string
  projectId: string
  environmentId: string
  status: 'enabled' | 'disabled'
  adminUserId: string
}) {
  const install = await db.pluginInstall.findUnique({
    where: {
      pluginId_projectId_environmentId: {
        pluginId: params.pluginId,
        projectId: params.projectId,
        environmentId: params.environmentId,
      },
    },
  })
  if (!install || install.status === 'uninstalled') {
    throw new PlatformError({
      code: 'PLUGIN_NOT_INSTALLED',
      category: 'not_found',
      message: `Plugin "${params.pluginId}" is not installed in this environment.`,
      status: 404,
    })
  }
  await db.pluginInstall.update({ where: { id: install.id }, data: { status: params.status } })

  if (params.status === 'enabled') {
    await enablePluginRuntime(params.pluginId, params.projectId)
  } else {
    // teardown: remove engine actions + archive plugin event schemas
    unregisterActionsByPlugin(params.pluginId)
    const module = findPluginModule(params.pluginId)
    for (const evt of module?.manifest.events ?? []) {
      await db.eventSchema.updateMany({
        where: { projectId: params.projectId, name: evt.name, version: evt.version },
        data: { status: 'archived' },
      })
    }
  }

  await recordAudit({
    projectId: params.projectId,
    environmentId: params.environmentId,
    actorType: 'human',
    actorId: params.adminUserId,
    action: params.status === 'enabled' ? 'plugin.enabled' : 'plugin.disabled',
    targetType: 'plugin',
    targetId: params.pluginId,
  })
  return { pluginId: params.pluginId, status: params.status }
}

export async function uninstallPlugin(params: {
  pluginId: string
  projectId: string
  environmentId: string
  adminUserId: string
}) {
  const install = await db.pluginInstall.findUnique({
    where: {
      pluginId_projectId_environmentId: {
        pluginId: params.pluginId,
        projectId: params.projectId,
        environmentId: params.environmentId,
      },
    },
  })
  if (!install || install.status === 'uninstalled') {
    throw new PlatformError({
      code: 'PLUGIN_NOT_INSTALLED',
      category: 'not_found',
      message: `Plugin "${params.pluginId}" is not installed.`,
      status: 404,
    })
  }
  // teardown runtime
  unregisterActionsByPlugin(params.pluginId)
  const module = findPluginModule(params.pluginId)
  for (const evt of module?.manifest.events ?? []) {
    await db.eventSchema.updateMany({
      where: { projectId: params.projectId, name: evt.name, version: evt.version },
      data: { status: 'archived' },
    })
  }
  await db.pluginInstall.update({ where: { id: install.id }, data: { status: 'uninstalled' } })
  await recordAudit({
    projectId: params.projectId,
    environmentId: params.environmentId,
    actorType: 'human',
    actorId: params.adminUserId,
    action: 'plugin.uninstalled',
    targetType: 'plugin',
    targetId: params.pluginId,
  })
  return { pluginId: params.pluginId, status: 'uninstalled' }
}

// ---------------------------------------------------------------------------
// Runtime hydration — re-register enabled plugins after a process restart.
// Memoized per process; called from ingestion + rule-management paths.
// ---------------------------------------------------------------------------

let hydrated = false
let hydrating: Promise<void> | null = null

/** Hydration flag on globalThis — shared across route bundles (Turbopack dev). */
const HG = globalThis as unknown as { __gogPluginsHydrated?: boolean }

export function resetPluginHydration() {
  hydrated = false
  HG.__gogPluginsHydrated = false
}

export async function ensureRuntimePlugins(): Promise<void> {
  if (hydrated || HG.__gogPluginsHydrated) return
  if (hydrating) return hydrating
  hydrating = (async () => {
    const enabled = await db.pluginInstall.findMany({ where: { status: 'enabled' }, select: { pluginId: true, projectId: true } })
    const seen = new Set<string>()
    for (const e of enabled) {
      if (seen.has(e.pluginId)) continue
      seen.add(e.pluginId)
      try {
        await enablePluginRuntime(e.pluginId, e.projectId)
      } catch (err) {
        console.error(`[plugins] failed to hydrate ${e.pluginId}:`, err)
      }
    }
    hydrated = true
    HG.__gogPluginsHydrated = true
  })()
  try {
    await hydrating
  } finally {
    hydrating = null
  }
}
