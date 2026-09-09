/**
 * GET /api/admin/rules-meta — metadata for the visual rule builder:
 * known event types (project schemas + canonical catalog), condition
 * operators, field namespaces, and the action registry (Section 2.3).
 * Session-authenticated (admin console only).
 */
import { NextRequest } from 'next/server'
import { json, apiError } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { db } from '@/lib/db'
import { getActionRegistry } from '@/server/engine/actions'
import { COMPARISON_OPERATORS, FIELD_NAMESPACES } from '@/server/engine/condition'
import { EVENT_CATALOG } from '@/server/registry/capability'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)

    const schemas = await db.eventSchema.findMany({
      where: { projectId: scope.projectId, status: 'active' },
      select: { name: true, version: true, description: true },
      orderBy: { name: 'asc' },
      take: 200,
    })

    const projectEvents = schemas.map((s) => ({
      name: s.name,
      version: s.version,
      description: s.description ?? '',
      source: 'schema' as const,
    }))
    const catalogEvents = EVENT_CATALOG.filter(
      (c) => !projectEvents.some((p) => p.name === c.name),
    ).map((c) => ({ name: c.name, version: 1, description: c.description, source: 'catalog' as const }))

    return json({
      eventTypes: [...projectEvents, ...catalogEvents],
      operators: COMPARISON_OPERATORS,
      fields: FIELD_NAMESPACES,
      actions: getActionRegistry(),
    })
  } catch (e) {
    return apiError(e)
  }
}
