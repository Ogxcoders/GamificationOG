/**
 * GamificationOG — Pack Service (Section 57).
 * Preview → Validate → Install → Uninstall lifecycle for reusable
 * behavior bundles. Objects are materialized through the same resource
 * validators the admin CRUD uses; PackInstall snapshots created ids
 * for precise, safe uninstall.
 */
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'
import { recordAudit } from '@/server/audit/service'
import { RESOURCES } from '@/server/admin/resources'
import type { PackObjectDef, PackDefinition } from './catalog'

export interface PackScope {
  projectId: string
  environmentId: string
}

interface PackObjectPlan {
  resource: string
  summary: string
  key: string // natural key: name / code / key
  status: 'create' | 'conflict'
  conflictReason?: string
}

export interface PackPreview {
  slug: string
  name: string
  version: string
  installed: boolean
  objects: PackObjectPlan[]
  counts: Record<string, number>
  conflicts: number
}

// Resource-specific create payloads → natural key + prisma delegate
const KIND_CONFIG: Record<string, {
  delegate: keyof typeof db
  uniqueField: string // field that must be unique per environment
  resourceConfig: string // RESOURCES key
  hasMetadata: boolean
  summarize: (def: Record<string, unknown>) => string
}> = {
  rules: {
    delegate: 'rule',
    uniqueField: 'name',
    resourceConfig: 'rules',
    hasMetadata: true,
    summarize: (d) => `WHEN ${String(d.eventType)} → ${firstActionType(String(d.actionsJson ?? '[]'))}`,
  },
  achievements: {
    delegate: 'achievement',
    uniqueField: 'code',
    resourceConfig: 'achievements',
    hasMetadata: true,
    summarize: (d) => `${String(d.name)} (${String(d.code)})`,
  },
  streaks: {
    delegate: 'streak',
    uniqueField: 'key',
    resourceConfig: 'streaks',
    hasMetadata: false,
    summarize: (d) => `${String(d.name)} on ${String(d.eventType)}`,
  },
  leaderboards: {
    delegate: 'leaderboard',
    uniqueField: 'code',
    resourceConfig: 'leaderboards',
    hasMetadata: true,
    summarize: (d) => `${String(d.name)} (${String(d.code)})`,
  },
}

function firstActionType(actionsJson: string): string {
  try {
    const arr = JSON.parse(actionsJson) as Array<{ type?: string }>
    return arr.map((a) => a.type ?? '?').join(', ') || 'no actions'
  } catch {
    return 'invalid actions'
  }
}

function packDefinitionObjects(def: PackDefinition): Array<{ kind: string; def: Record<string, unknown> }> {
  const out: Array<{ kind: string; def: Record<string, unknown> }> = []
  for (const kind of ['rules', 'achievements', 'streaks', 'leaderboards'] as const) {
    const list = def[kind] as Array<Record<string, unknown>> | undefined
    if (Array.isArray(list)) {
      for (const item of list) out.push({ kind, def: { ...item, resource: undefined } })
    }
  }
  return out
}

async function assertPack(slug: string) {
  const pack = await db.pack.findUnique({ where: { slug } })
  if (!pack) {
    throw new PlatformError({
      code: 'PACK_NOT_FOUND',
      category: 'not_found',
      message: `Pack "${slug}" does not exist in the catalog.`,
      fix: 'List available packs via GET /api/admin/packs.',
    })
  }
  return pack
}

async function currentInstall(packId: string, scope: PackScope) {
  const install = await db.packInstall.findFirst({
    where: { packId, projectId: scope.projectId, environmentId: scope.environmentId },
    orderBy: { installedAt: 'desc' },
  })
  return install && install.status === 'installed' ? install : null
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listPacks(scope: PackScope) {
  const [packs, installs] = await Promise.all([
    db.pack.findMany({ where: { status: 'published' }, orderBy: [{ category: 'asc' }, { name: 'asc' }] }),
    db.packInstall.findMany({
      where: { projectId: scope.projectId, environmentId: scope.environmentId, status: 'installed' },
      include: { pack: true },
    }),
  ])
  const installedBySlug = new Map(installs.map((i) => [i.pack.slug, i]))
  return packs.map((pack) => {
    const def = safeParse(pack.definitionJson)
    return {
      slug: pack.slug,
      name: pack.name,
      description: pack.description ?? '',
      category: pack.category,
      version: pack.version,
      counts: {
        rules: def.rules?.length ?? 0,
        achievements: def.achievements?.length ?? 0,
        streaks: def.streaks?.length ?? 0,
        leaderboards: def.leaderboards?.length ?? 0,
      },
      installedAt: installedBySlug.get(pack.slug)?.installedAt ?? null,
    }
  })
}

function safeParse(text: string): PackDefinition {
  try {
    return JSON.parse(text || '{}') as PackDefinition
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Preview — validation + conflict detection without side effects
// ---------------------------------------------------------------------------

export async function previewPack(slug: string, scope: PackScope): Promise<PackPreview> {
  const pack = await assertPack(slug)
  const def = safeParse(pack.definitionJson)
  const objects = packDefinitionObjects(def)

  const plan: PackObjectPlan[] = []
  let conflicts = 0

  for (const { kind, def: objectDef } of objects) {
    const config = KIND_CONFIG[kind]
    if (!config) continue
    const naturalKey = String(objectDef[config.uniqueField] ?? '')

    // validate the object exactly like manual admin creation
    const data: Record<string, unknown> = {}
    for (const field of RESOURCES[config.resourceConfig].fields) {
      if (objectDef[field] !== undefined) data[field] = objectDef[field]
    }
    let conflictReason: string | undefined
    try {
      await RESOURCES[config.resourceConfig].validate?.(data, 'create')
    } catch (e) {
      conflictReason = e instanceof Error ? e.message : 'validation failed'
    }

    if (!conflictReason) {
      // uniqueness within environment
      // @ts-expect-error dynamic prisma delegate access
      const delegate = db[config.delegate] as { findFirst: (args: Record<string, unknown>) => Promise<unknown> }
      const existing = await delegate.findFirst({
        where: { projectId: scope.projectId, environmentId: scope.environmentId, [config.uniqueField]: naturalKey },
      })
      if (existing) {
        conflictReason = `A ${kind.replace(/s$/, '')} with ${config.uniqueField} "${naturalKey}" already exists in this environment`
      }
    }

    if (conflictReason) {
      conflicts++
      plan.push({ resource: kind, summary: config.summarize(objectDef), key: naturalKey, status: 'conflict', conflictReason })
    } else {
      plan.push({ resource: kind, summary: config.summarize(objectDef), key: naturalKey, status: 'create' })
    }
  }

  return {
    slug: pack.slug,
    name: pack.name,
    version: pack.version,
    installed: (await currentInstall(pack.id, scope)) !== null,
    objects: plan,
    counts: {
      rules: def.rules?.length ?? 0,
      achievements: def.achievements?.length ?? 0,
      streaks: def.streaks?.length ?? 0,
      leaderboards: def.leaderboards?.length ?? 0,
    },
    conflicts,
  }
}

// ---------------------------------------------------------------------------
// Install — materialize objects, snapshot ids
// ---------------------------------------------------------------------------

export async function installPack(slug: string, scope: PackScope, adminUserId: string) {
  const pack = await assertPack(slug)

  const existingInstall = await currentInstall(pack.id, scope)
  if (existingInstall) {
    throw new PlatformError({
      code: 'PACK_ALREADY_INSTALLED',
      category: 'conflict',
      message: `Pack "${pack.name}" is already installed in this environment (installed ${existingInstall.installedAt.toISOString().slice(0, 10)}).`,
      fix: 'Uninstall it first, or preview to inspect the objects it would create.',
    })
  }

  const preview = await previewPack(slug, scope)
  if (preview.conflicts > 0) {
    throw new PlatformError({
      code: 'PACK_CONFLICTS',
      category: 'conflict',
      message: `${preview.conflicts} object(s) conflict with existing configuration in this environment.`,
      fix: 'Resolve the conflicts listed in the preview, then retry the install.',
      detail: preview.objects.filter((o) => o.status === 'conflict').map((o) => `${o.resource}: ${o.conflictReason}`).join('; '),
    })
  }

  const def = safeParse(pack.definitionJson)
  const objects = packDefinitionObjects(def)

  // Transactional install (§60 rollback-on-failure): objects and the install
  // record commit atomically. Reinstall after uninstall upserts the existing
  // install row (unique on pack+project+environment).
  const createdSummaries = await db.$transaction(async (tx) => {
    const createdIds: Record<string, string[]> = { rules: [], achievements: [], streaks: [], leaderboards: [] }
    const created: Array<{ resource: string; name: string; id: string }> = []

    for (const { kind, def: objectDef } of objects) {
      const config = KIND_CONFIG[kind]
      if (!config) continue

      const data: Record<string, unknown> = {}
      for (const field of RESOURCES[config.resourceConfig].fields) {
        if (objectDef[field] !== undefined) data[field] = objectDef[field]
      }
      if (config.hasMetadata) {
        const meta = safeParseMetadata(String(data.metadataJson ?? '{}'))
        meta.packSlug = pack.slug
        meta.packName = pack.name
        data.metadataJson = JSON.stringify(meta)
      }

      // @ts-expect-error dynamic prisma delegate access
      const delegate = tx[config.delegate] as { create: (args: Record<string, unknown>) => Promise<{ id: string; name?: string; code?: string; key?: string }> }
      const record = await delegate.create({
        data: { ...data, projectId: scope.projectId, environmentId: scope.environmentId },
      })
      createdIds[kind].push(record.id)
      created.push({ resource: kind, name: String(record.name ?? record.code ?? record.key ?? record.id), id: record.id })
    }

    await tx.packInstall.upsert({
      where: {
        packId_projectId_environmentId: {
          packId: pack.id,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
      },
      create: {
        packId: pack.id,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        status: 'installed',
        installedById: adminUserId,
        installedJson: JSON.stringify(createdIds),
      },
      update: {
        status: 'installed',
        installedById: adminUserId,
        installedAt: new Date(),
        uninstalledAt: null,
        installedJson: JSON.stringify(createdIds),
      },
    })

    return created
  })

  await recordAudit({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    actorType: 'human',
    actorId: adminUserId,
    action: 'pack.installed',
    targetType: 'pack',
    targetId: pack.id,
    afterJson: JSON.stringify({ slug: pack.slug, version: pack.version, created: createdSummaries }),
  })

  return {
    slug: pack.slug,
    installed: createdSummaries.length,
    created: createdSummaries,
  }
}

function safeParseMetadata(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    /* ignore */
  }
  return {}
}

// ---------------------------------------------------------------------------
// Uninstall — rollback semantics (§60): pristine objects removed cleanly,
// user-modified objects archived
// ---------------------------------------------------------------------------

export async function uninstallPack(slug: string, scope: PackScope, adminUserId: string) {
  const pack = await assertPack(slug)
  const install = await currentInstall(pack.id, scope)
  if (!install) {
    throw new PlatformError({
      code: 'PACK_NOT_INSTALLED',
      category: 'conflict',
      message: `Pack "${pack.name}" is not installed in this environment.`,
      fix: 'Install it first.',
    })
  }

  const snapshot = safeParseIds(install.installedJson)
  const removed: Array<{ resource: string; id: string; action: 'removed' | 'archived' | 'missing' }> = []
  // pristine objects (untouched since install) are hard-deleted so the pack
  // can be reinstalled; objects the user modified after install are archived
  // (their work is preserved) and will conflict on reinstall.
  const PRISTINE_GRACE_MS = 50

  for (const kind of ['rules', 'achievements', 'streaks', 'leaderboards'] as const) {
    const config = KIND_CONFIG[kind]
    const ids = snapshot[kind] ?? []
    for (const id of ids) {
      // @ts-expect-error dynamic prisma delegate access
      const delegate = db[config.delegate] as {
        findUnique: (args: Record<string, unknown>) => Promise<{ id: string; status: string; updatedAt: Date } | null>
        update: (args: Record<string, unknown>) => Promise<unknown>
        delete: (args: Record<string, unknown>) => Promise<unknown>
      }
      const obj = await delegate.findUnique({ where: { id } })
      if (!obj) {
        removed.push({ resource: kind, id, action: 'missing' })
        continue
      }
      const pristine = obj.updatedAt.getTime() <= install.installedAt.getTime() + PRISTINE_GRACE_MS
      if (pristine) {
        await delegate.delete({ where: { id } })
        removed.push({ resource: kind, id, action: 'removed' })
      } else if (obj.status === 'active' || obj.status === 'published') {
        await delegate.update({ where: { id }, data: { status: 'archived' } })
        removed.push({ resource: kind, id, action: 'archived' })
      } else {
        // modified and already non-active — leave as-is, it is user state now
        removed.push({ resource: kind, id, action: 'archived' })
      }
    }
  }

  await db.packInstall.update({
    where: { id: install.id },
    data: { status: 'uninstalled', uninstalledAt: new Date() },
  })

  await recordAudit({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    actorType: 'human',
    actorId: adminUserId,
    action: 'pack.uninstalled',
    targetType: 'pack',
    targetId: pack.id,
    afterJson: JSON.stringify({ slug: pack.slug, removed }),
  })

  return {
    slug: pack.slug,
    removed,
    removedClean: removed.filter((r) => r.action === 'removed').length,
    archived: removed.filter((r) => r.action === 'archived').length,
  }
}

function safeParseIds(text: string): Record<string, string[]> {
  try {
    const parsed = JSON.parse(text || '{}')
    if (parsed && typeof parsed === 'object') {
      const out: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) out[k] = v.map(String)
      }
      return out
    }
  } catch {
    /* ignore */
  }
  return {}
}
