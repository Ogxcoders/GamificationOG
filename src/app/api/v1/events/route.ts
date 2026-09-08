/**
 * POST /api/v1/events — Event Gateway ingestion endpoint (Section 10).
 * SDK-facing: authenticate (API key), validate schema, idempotency,
 * process synchronously through the full pipeline, return state deltas
 * + trace id (Customer Zero flow: track event -> see state change).
 */
import { NextRequest } from 'next/server'
import { json, apiError, requireApiKey, requireScope, readJson } from '@/lib/api'
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
