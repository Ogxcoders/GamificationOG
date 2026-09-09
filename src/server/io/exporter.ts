/**
 * GamificationOG — Package Exporter (Section 59).
 * Builds a portable, environment-independent package of the gamification
 * system: event contracts + engagement configuration. Internal ids and
 * timestamps are stripped — objects are keyed by natural keys so the
 * importer can diff/merge into any environment.
 */
import { db } from '@/lib/db'
import { RESOURCES } from '@/server/admin/resources'

export const EXPORT_PACKAGE_KIND = 'gamificationog.gamification-system'
export const EXPORT_PACKAGE_VERSION = 1

/** Resource kinds included in a gamification-system package (in stable order). */
export const EXPORT_RESOURCES = [
  'event-schemas',
  'rules',
  'progression',
  'challenges',
  'achievements',
  'streaks',
  'rewards',
  'currencies',
  'items',
  'leaderboards',
  'segments',
] as const

export type ExportResource = (typeof EXPORT_RESOURCES)[number]

/** Natural (identity) field per resource — used by the importer for diffing. */
export const NATURAL_KEYS: Record<ExportResource, string> = {
  'event-schemas': 'name',
  rules: 'name',
  progression: 'code',
  challenges: 'name',
  achievements: 'code',
  streaks: 'key',
  rewards: 'code',
  currencies: 'code',
  items: 'code',
  leaderboards: 'code',
  segments: 'name',
}

export interface ExportScope {
  projectId: string
  environmentId: string
  projectName: string
  environmentName: string
}

export interface ExportedPackage {
  manifest: {
    kind: string
    packageVersion: number
    platform: string
    exportedAt: string
    project: string
    environment: string
    counts: Record<string, number>
  }
  resources: Record<string, Array<Record<string, unknown>>>
}

export async function exportGamificationSystem(scope: ExportScope): Promise<ExportedPackage> {
  const resources: Record<string, Array<Record<string, unknown>>> = {}
  const counts: Record<string, number> = {}

  for (const resource of EXPORT_RESOURCES) {
    const config = RESOURCES[resource]
    // @ts-expect-error dynamic prisma delegate access
    const delegate = db[config.delegate] as { findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> }
    const where: Record<string, unknown> = { projectId: scope.projectId }
    if (!config.projectScoped) where.environmentId = scope.environmentId

    const rows = await delegate.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 1000,
    })

    // strip internal ids/timestamps/scope — keep declared config fields only
    const objects: Array<Record<string, unknown>> = []
    for (const row of rows) {
      if (String(row.status ?? '') === 'archived') continue // lifecycle-dead objects are not portable
      const obj: Record<string, unknown> = {}
      for (const field of config.fields) {
        if (row[field] === undefined) continue
        const value = row[field]
        if (field.endsWith('Json')) {
          obj[field] = safeJson(value) // normalized parsed JSON, not stringified twice
        } else {
          obj[field] = value
        }
      }
      objects.push(obj)
    }
    resources[resource] = objects
    counts[resource] = objects.length
  }

  return {
    manifest: {
      kind: EXPORT_PACKAGE_KIND,
      packageVersion: EXPORT_PACKAGE_VERSION,
      platform: 'GamificationOG',
      exportedAt: new Date().toISOString(),
      project: scope.projectName,
      environment: scope.environmentName,
      counts,
    },
    resources,
  }
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
