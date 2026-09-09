/**
 * /api/v1/events — Event ingestion (POST, Section 10) + recent event feed
 * for SDKs and AI agents (GET, MCP control plane Sections 65, 153).
 *
 * POST: SDK-facing event gateway — authenticate (API key, events:write),
 * validate schema, idempotency, process synchronously through the full
 * pipeline, return state deltas + trace id (Customer Zero flow).
 *
 * GET: read-only event feed (events:read) with status and type
 * distribution — mirrors the admin feed shape so agents can reason
 * about ingestion health without dashboard access.
 */
import { NextRequest } from 'next/server'
import { json, apiError, requireApiKey, requireScope, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { ingestEvent } from '@/server/events/gateway'
import type { EventIngestionRequest, EventProcessingResult } from '@/server/core/types'

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'events:write')
    const body = await readJson<EventIngestionRequest | { events: EventIngestionRequest[] }>(req)

    // batch ingestion support (Section 10 — batch ingestion)
    if ('events' in body && Array.isArray(body.events)) {
      const results: EventProcessingResult[] = []
      for (const e of body.events.slice(0, 100)) {
        results.push(
          await ingestEvent({
            projectId: auth.projectId,
            environmentId: auth.environmentId,
            request: e,
          }),
        )
      }
      return json({ batch: true, results })
    }

    const result = await ingestEvent({
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      request: body as EventIngestionRequest,
    })
    return json(result)
  } catch (e) {
    return apiError(e)
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'events:read')
    const url = new URL(req.url)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 200)
    const eventType = url.searchParams.get('type')
    const status = url.searchParams.get('status')

    const where: Record<string, unknown> = { projectId: auth.projectId, environmentId: auth.environmentId }
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
      where: { projectId: auth.projectId, environmentId: auth.environmentId },
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
        payload: JSON.parse(e.payloadJson),
        occurredAt: e.occurredAt,
        receivedAt: e.receivedAt,
        traceId: e.decisionTraces[0]?.id ?? null,
        processingError: e.processingError,
      })),
      typeCounts: typeCounts.map((t) => ({ type: t.eventType, count: t._count.id })),
      scope: { projectId: auth.projectId, environmentId: auth.environmentId },
    })
  } catch (e) {
    return apiError(e)
  }
}
