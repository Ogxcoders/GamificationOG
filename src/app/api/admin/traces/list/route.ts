/**
 * GET /api/admin/traces — decision trace list + detail (Section 70).
 * The full decision graph: every context build, rule evaluation,
 * action execution with before/after state.
 */
import { NextRequest } from 'next/server'
import { json, apiError } from '@/lib/api'
import { db } from '@/lib/db'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { parseJson, type TraceStep } from '@/server/core/types'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    const userId = url.searchParams.get('userId')
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 30) || 30, 200)

    if (id) {
      const trace = await db.decisionTrace.findUnique({
        where: { id },
        include: {
          event: { include: { appUser: { select: { externalId: true, displayName: true } } } },
        },
      })
      if (!trace || trace.projectId !== scope.projectId) {
        return json({ error: { code: 'NOT_FOUND', message: 'Trace not found.' } }, 404)
      }
      return json({
        trace: {
          ...trace,
          steps: parseJson<TraceStep[]>(trace.stepsJson, []),
          event: trace.event
            ? {
                eventId: trace.event.eventId,
                type: trace.event.eventType,
                payload: parseJson<Record<string, unknown>>(trace.event.payloadJson, {}),
                user: trace.event.appUser?.externalId ?? null,
                occurredAt: trace.event.occurredAt,
              }
            : null,
        },
      })
    }

    const where: Record<string, unknown> = { projectId: scope.projectId, environmentId: scope.environmentId }
    if (userId) where.appUserId = userId

    const traces = await db.decisionTrace.findMany({
      where: where as never,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { appUser: { select: { externalId: true, displayName: true } } },
    })

    return json({
      traces: traces.map((t) => ({
        id: t.id,
        eventType: t.eventType,
        user: t.appUser ? (t.appUser.displayName ?? t.appUser.externalId) : null,
        summary: t.summary,
        actionsCount: t.actionsCount,
        durationMs: t.durationMs,
        createdAt: t.createdAt,
        correlationId: t.correlationId,
      })),
      scope,
    })
  } catch (e) {
    return apiError(e)
  }
}
