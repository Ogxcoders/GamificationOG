/**
 * GET /api/admin/events/feed — event stream with filters.
 * POST /api/admin/events/feed — reprocess an event (replay, Section 10).
 */
import { NextRequest } from 'next/server'
import { json, apiError } from '@/lib/api'
import { db } from '@/lib/db'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { processEvent } from '@/server/events/gateway'
import { parseJson } from '@/server/core/types'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const url = new URL(req.url)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500)
    const eventType = url.searchParams.get('type')
    const status = url.searchParams.get('status')

    const where: Record<string, unknown> = { projectId: scope.projectId, environmentId: scope.environmentId }
    if (eventType) where.eventType = eventType
    if (status) where.status = status

    const events = await db.event.findMany({
      where: where as never,
      orderBy: { receivedAt: 'desc' },
      take: limit,
      include: {
        appUser: { select: { externalId: true, displayName: true } },
        decisionTraces: { select: { id: true } },
      },
    })

    const typeCounts = await db.event.groupBy({
      by: ['eventType'],
      where: { projectId: scope.projectId, environmentId: scope.environmentId },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 20,
    })

    return json({
      events: events.map((e) => ({
        id: e.id,
        eventId: e.eventId,
        type: e.eventType,
        status: e.status,
        source: e.source,
        user: e.appUser ? (e.appUser.displayName ?? e.appUser.externalId) : null,
        payload: parseJson<Record<string, unknown>>(e.payloadJson, {}),
        occurredAt: e.occurredAt,
        receivedAt: e.receivedAt,
        correlationId: e.correlationId,
        hasTrace: e.decisionTraces.length > 0,
      })),
      typeCounts: typeCounts.map((t) => ({ type: t.eventType, count: t._count.id })),
      scope,
    })
  } catch (e) {
    return apiError(e)
  }
}

/** POST — replay/reprocess an event by internal id (debugging + new ruleset evaluation). */
export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const eventId = new URL(req.url).searchParams.get('eventId')
    if (!eventId) return json({ error: { code: 'EVENT_ID_REQUIRED', message: 'Query param eventId required.' } }, 400)

    const event = await db.event.findUnique({ where: { id: eventId } })
    if (!event || event.projectId !== scope.projectId) {
      return json({ error: { code: 'NOT_FOUND', message: 'Event not found.' } }, 404)
    }

    const result = await processEvent({
      eventRowId: event.id,
      eventId: event.eventId + ':replay:' + Date.now(),
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      projectId: event.projectId,
      environmentId: event.environmentId,
      appUserId: event.actorId ?? '',
      subjectId: event.subjectId,
      source: event.source,
      occurredAt: new Date(),
      correlationId: event.correlationId ?? 'replay',
      payload: parseJson<Record<string, unknown>>(event.payloadJson, {}),
    })
    return json({ replay: true, result })
  } catch (e) {
    return apiError(e)
  }
}
