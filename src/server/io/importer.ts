/**
 * GamificationOG — Package Importer (Section 60 pipeline).
 * Import → Preview(dry-run) → Validation → Compatibility → Diff →
 * Conflict Detection → Apply (skip|overwrite) → Audit.
 *
 * JSON-typed fields arrive parsed (object form) in packages and are
 * re-stringified to the storage convention before validation/creation.
 * Apply runs inside a transaction — failure rolls back everything (§60).
 */
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'
import { recordAudit } from '@/server/audit/service'
import { RESOURCES } from '@/server/admin/resources'
import { EXPORT_PACKAGE_KIND, EXPORT_PACKAGE_VERSION, EXPORT_RESOURCES, NATURAL_KEYS, type ExportResource } from './exporter'

export type ImportStrategy = 'skip' | 'overwrite'
export type ImportMode = 'dry-run' | 'apply'

export interface ImportScope {
  projectId: string
  environmentId: string
}

interface ObjectPlan {
  resource: string
  naturalKey: string
  action: 'create' | 'overwrite' | 'skip' | 'identical'
  reason?: string
}

export interface ImportPreview {
  mode: ImportMode
  strategy: ImportStrategy
  manifest: Record<string, unknown>
  objects: ObjectPlan[]
  summary: { create: number; overwrite: number; skip: number; identical: number }
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Validation + compatibility (§60)
// ---------------------------------------------------------------------------

function validatePackageShape(pkg: unknown): Record<string, unknown> {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new PlatformError({
      code: 'IMPORT_INVALID_PACKAGE',
      category: 'validation',
      message: 'Package must be a JSON object.',
      fix: 'Use the output of GET /api/admin/export.',
    })
  }
  const p = pkg as Record<string, unknown>
  const manifest = p.manifest
  if (!manifest || typeof manifest !== 'object') {
    throw new PlatformError({
      code: 'IMPORT_INVALID_PACKAGE',
      category: 'validation',
      message: 'Package is missing its manifest.',
      fix: 'The manifest describes kind, version, and compatibility.',
    })
  }
  const m = manifest as Record<string, unknown>
  if (m.kind !== EXPORT_PACKAGE_KIND) {
    throw new PlatformError({
      code: 'IMPORT_INCOMPATIBLE',
      category: 'validation',
      message: `Package kind "${String(m.kind)}" is not importable here.`,
      fix: `This importer accepts "${EXPORT_PACKAGE_KIND}" packages.`,
    })
  }
  if (typeof m.packageVersion !== 'number' || m.packageVersion > EXPORT_PACKAGE_VERSION) {
    throw new PlatformError({
      code: 'IMPORT_INCOMPATIBLE',
      category: 'validation',
      message: `Package version ${String(m.packageVersion)} is newer than this platform supports (${EXPORT_PACKAGE_VERSION}).`,
      fix: 'Export from a compatible platform version.',
    })
  }
  if (!p.resources || typeof p.resources !== 'object') {
    throw new PlatformError({
      code: 'IMPORT_INVALID_PACKAGE',
      category: 'validation',
      message: 'Package is missing its resources section.',
    })
  }
  return p
}

/** Re-stringify JSON fields to storage convention; drop unknown fields. */
function normalizeObject(resource: ExportResource, raw: Record<string, unknown>): Record<string, unknown> {
  const config = RESOURCES[resource]
  const out: Record<string, unknown> = {}
  for (const field of config.fields) {
    const value = raw[field]
    if (value === undefined) continue
    if (field.endsWith('Json')) {
      out[field] = typeof value === 'string' ? value : JSON.stringify(value)
    } else {
      out[field] = value
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Diff / conflict detection
// ---------------------------------------------------------------------------

function objectsOf(pkg: Record<string, unknown>): Array<{ resource: ExportResource; obj: Record<string, unknown> }> {
  const resources = pkg.resources as Record<string, unknown>
  const out: Array<{ resource: ExportResource; obj: Record<string, unknown> }> = []
  for (const resource of EXPORT_RESOURCES) {
    const list = resources[resource]
    if (list === undefined) continue
    if (!Array.isArray(list)) {
      throw new PlatformError({
        code: 'IMPORT_INVALID_PACKAGE',
        category: 'validation',
        message: `resources.${resource} must be an array.`,
      })
    }
    for (const obj of list) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new PlatformError({
          code: 'IMPORT_INVALID_PACKAGE',
          category: 'validation',
          message: `resources.${resource} contains a non-object entry.`,
        })
      }
      out.push({ resource, obj: obj as Record<string, unknown> })
    }
  }
  // unknown resource kinds → warning (forward compatibility)
  for (const key of Object.keys(resources)) {
    if (!(EXPORT_RESOURCES as readonly string[]).includes(key)) {
      throw new PlatformError({
        code: 'IMPORT_UNKNOWN_RESOURCE',
        category: 'validation',
        message: `Package contains unknown resource kind "${key}".`,
        fix: `Supported: ${EXPORT_RESOURCES.join(', ')}`,
      })
    }
  }
  return out
}

async function findExisting(resource: ExportResource, scope: ImportScope, naturalKey: string) {
  const config = RESOURCES[resource]
  // @ts-expect-error dynamic prisma delegate access
  const delegate = db[config.delegate] as { findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null> }
  const where: Record<string, unknown> = { projectId: scope.projectId }
  if (!config.projectScoped) where.environmentId = scope.environmentId
  where[NATURAL_KEYS[resource]] = naturalKey
  return delegate.findFirst({ where })
}

/**
 * Content equality over the fields the PACKAGE defines. DB-side defaults for
 * fields the package omits (e.g. `version`) are not divergence — the package
 * simply doesn't manage them.
 */
function contentMatches(existing: Record<string, unknown>, incoming: Record<string, unknown>): boolean {
  for (const key of Object.keys(incoming)) {
    if (key === 'status') continue
    if (JSON.stringify(existing[key]) !== JSON.stringify(incoming[key])) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Preview (dry-run) — validation + diff, no side effects
// ---------------------------------------------------------------------------

export async function previewImport(pkg: unknown, scope: ImportScope, strategy: ImportStrategy): Promise<ImportPreview> {
  const p = validatePackageShape(pkg)
  const entries = objectsOf(p)
  const plan: ObjectPlan[] = []
  const warnings: string[] = []
  const summary = { create: 0, overwrite: 0, skip: 0, identical: 0 }

  for (const { resource, obj } of entries) {
    const config = RESOURCES[resource]
    const naturalKey = String(obj[NATURAL_KEYS[resource]] ?? '')
    if (!naturalKey) {
      summary.skip++
      plan.push({ resource, naturalKey: '', action: 'skip', reason: `missing natural key "${NATURAL_KEYS[resource]}"` })
      warnings.push(`${resource}: object without a "${NATURAL_KEYS[resource]}" natural key was skipped`)
      continue
    }
    const normalized = normalizeObject(resource, obj)

    // 1. semantic validation (same as manual creation)
    let invalid: string | undefined
    try {
      await config.validate?.(normalized, 'create')
    } catch (e) {
      invalid = e instanceof Error ? e.message : 'validation failed'
    }
    if (invalid) {
      summary.skip++
      plan.push({ resource, naturalKey, action: 'skip', reason: `invalid: ${invalid}` })
      warnings.push(`${resource}/${naturalKey}: ${invalid}`)
      continue
    }

    // 2. conflict detection
    const existing = await findExisting(resource, scope, naturalKey)
    if (!existing) {
      summary.create++
      plan.push({ resource, naturalKey, action: 'create' })
      continue
    }

    // 3. diff — identical or diverged? (compares only package-defined fields)
    const existingProjected: Record<string, unknown> = {}
    for (const field of config.fields) {
      if (existing[field] === undefined) continue
      const value = existing[field]
      existingProjected[field] = field.endsWith('Json') ? safeJson(value) : value
    }
    const normalizedParsed: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(normalized)) {
      normalizedParsed[k] = fieldEndsJson(k) ? safeJson(v) : v
    }
    const identical = contentMatches(existingProjected, normalizedParsed)

    if (identical) {
      summary.identical++
      plan.push({ resource, naturalKey, action: 'identical', reason: 'already present with identical content' })
    } else if (strategy === 'overwrite') {
      summary.overwrite++
      plan.push({ resource, naturalKey, action: 'overwrite' })
    } else {
      summary.skip++
      plan.push({ resource, naturalKey, action: 'skip', reason: 'exists with different content (skip strategy)' })
    }
  }

  return {
    mode: 'dry-run',
    strategy,
    manifest: p.manifest as Record<string, unknown>,
    objects: plan,
    summary,
    warnings,
  }
}

function fieldEndsJson(field: string): boolean {
  return field.endsWith('Json')
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

// ---------------------------------------------------------------------------
// Apply — transactional (§60 rollback on failure)
// ---------------------------------------------------------------------------

export async function applyImport(
  pkg: unknown,
  scope: ImportScope,
  strategy: ImportStrategy,
  adminUserId: string,
): Promise<ImportPreview & { applied: boolean }> {
  const preview = await previewImport(pkg, scope, strategy)

  // transactional apply
  const applied = await db.$transaction(async (tx) => {
    let created = 0
    let overwritten = 0

    for (const { resource, obj } of objectsOf(validatePackageShape(pkg))) {
      const planEntry = preview.objects.find(
        (o) => o.resource === resource && o.naturalKey === String(obj[NATURAL_KEYS[resource]] ?? ''),
      )
      const action = planEntry?.action
      if (action !== 'create' && action !== 'overwrite') continue

      const config = RESOURCES[resource]
      const naturalKey = String(obj[NATURAL_KEYS[resource]] ?? '')
      const normalized = normalizeObject(resource, obj)

      // @ts-expect-error dynamic prisma delegate access
      const delegate = tx[config.delegate] as {
        create: (args: Record<string, unknown>) => Promise<unknown>
        update: (args: Record<string, unknown>) => Promise<unknown>
        findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
      }

      if (action === 'create') {
        const createData: Record<string, unknown> = { ...normalized, projectId: scope.projectId }
        if (!config.projectScoped) createData.environmentId = scope.environmentId
        await delegate.create({ data: createData })
        created++
      } else {
        const existing = await findExistingTx(tx, resource, scope, naturalKey)
        if (!existing) continue // raced away — skip safely
        const where = { id: existing.id }
        await delegate.update({ where, data: normalized })
        overwritten++
      }
    }
    return { created, overwritten }
  })

  await recordAudit({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    actorType: 'human',
    actorId: adminUserId,
    action: 'import.applied',
    targetType: 'package',
    targetId: String((pkg as { manifest?: { exportedAt?: string } })?.manifest?.exportedAt ?? 'unknown'),
    afterJson: JSON.stringify({
      strategy,
      summary: preview.summary,
      created: applied.created,
      overwritten: applied.overwritten,
    }),
  })

  return { ...preview, mode: 'apply', applied: true }
}

async function findExistingTx(
  tx: unknown,
  resource: ExportResource,
  scope: ImportScope,
  naturalKey: string,
): Promise<Record<string, unknown> | null> {
  const config = RESOURCES[resource]
  // @ts-expect-error dynamic prisma delegate access
  const delegate = (tx as Record<string, unknown>)[config.delegate] as {
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  }
  const where: Record<string, unknown> = { projectId: scope.projectId }
  if (!config.projectScoped) where.environmentId = scope.environmentId
  where[NATURAL_KEYS[resource]] = naturalKey
  return delegate.findFirst({ where })
}
