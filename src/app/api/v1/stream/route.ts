/**
 * /api/v1/stream — Realtime SSE channel (§78 Realtime System).
 *
 * GET /api/v1/stream?topics=events,leaderboard
 *
 * Authentication : Bearer API key with `events:read` scope
 * Authorization  : topics are scoped to the key's project+environment —
 *                  a key can never stream another project's traffic
 * Subscription   : `topics` query param (comma-separated; supports `*` and
 *                  prefixes — `leaderboard` matches `leaderboard:<name>`);
 *                  default `events,leaderboard`
 * Ordering       : `id: <seq>` on every message (global monotonic)
 * Reconnect      : send Last-Event-ID (or ?last_event_id=) → missed messages
 *                  replay from the in-memory ring; `retry: 3000` hint
 * Backpressure   : bounded per-client queue — slow clients are dropped and
 *                  reconnect rather than buffering without bound
 *
 * Framing:
 *   event: hello    → {connectionId, topics, lastSeq, retryMs}
 *   event: replay   → missed messages after reconnect
 *   event: message  → live traffic (topic + type + data)
 *   `: ping` comment lines every 15s keep proxies from idling the connection
 */
import { NextRequest } from 'next/server'
import { apiError } from '@/lib/api'
import { requireApiKey, requireScope } from '@/lib/api'
import { registerClient, replayAfter, REALTIME_CONSTANTS, type RealtimeMessage } from '@/server/realtime/hub'

export const dynamic = 'force-dynamic'

function sseFrame(msg: RealtimeMessage): string {
  return `id: ${msg.seq}\nevent: ${msg.type === 'heartbeat' ? 'message' : 'message'}\ndata: ${JSON.stringify({
    seq: msg.seq,
    topic: msg.topic,
    type: msg.type,
    data: msg.data,
    at: msg.at,
  })}\n\n`
}

export async function GET(req: NextRequest) {
  // Browser EventSource cannot set Authorization headers — accept the API
  // key via the `key` query parameter as a fallback for the SSE channel
  // only. Proxying integrations should prefer the Authorization header.
  // (Keys in URLs can appear in access logs — documented tradeoff.)
  const url = new URL(req.url)
  const keyParam = url.searchParams.get('key')
  let authReq = req
  if (keyParam && !req.headers.get('authorization')) {
    const headers = new Headers(req.headers)
    headers.set('authorization', `Bearer ${keyParam}`)
    authReq = new NextRequest(req.url, { headers, signal: req.signal })
  }

  let auth
  try {
    auth = await requireApiKey(authReq)
    requireScope(auth, 'events:read')
  } catch (e) {
    return apiError(e)
  }

  const topicsRaw = url.searchParams.get('topics') ?? 'events,leaderboard'
  const topics = topicsRaw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && /^[a-z0-9_*:-]+$/.test(t))
    .slice(0, 20)
  if (topics.length === 0) {
    return Response.json(
      { error: { code: 'INVALID_TOPICS', category: 'validation', message: 'No valid topics in "topics" query parameter.' } },
      { status: 400 },
    )
  }

  const lastEventIdHeader = req.headers.get('last-event-id') ?? url.searchParams.get('last_event_id')
  const afterSeq = lastEventIdHeader ? Number(lastEventIdHeader) : 0
  const connectionId = crypto.randomUUID()

  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const safeEnqueue = (chunk: string): boolean => {
        if (closed) return false
        try {
          controller.enqueue(encoder.encode(chunk))
          return true
        } catch {
          closed = true
          return false
        }
      }

      // retry hint + hello frame
      safeEnqueue(`retry: ${REALTIME_CONSTANTS.RETRY_HINT_MS}\n\n`)
      safeEnqueue(
        `event: hello\ndata: ${JSON.stringify({
          connectionId,
          topics,
          lastSeq: afterSeq,
          retryMs: REALTIME_CONSTANTS.RETRY_HINT_MS,
          heartbeatMs: REALTIME_CONSTANTS.HEARTBEAT_MS,
        })}\n\n`,
      )

      // replay missed messages (Last-Event-ID reconnect support)
      if (Number.isFinite(afterSeq) && afterSeq > 0) {
        for (const missed of replayAfter(auth.projectId, auth.environmentId, topics, afterSeq)) {
          if (!safeEnqueue(sseFrame(missed))) break
        }
      }

      let queued = 0
      unsubscribe = registerClient({
        id: connectionId,
        projectId: auth.projectId,
        environmentId: auth.environmentId,
        topics,
        send: (msg) => {
          if (msg.type === 'heartbeat') {
            // heartbeat as SSE comment — keeps proxies alive, invisible to clients
            return safeEnqueue(`: ping ${msg.at}\n\n`)
          }
          queued++
          // Backpressure (§78): bounded per-client queue. Slow consumers are
          // dropped and expected to reconnect + replay via Last-Event-ID.
          if (queued > REALTIME_CONSTANTS.MAX_CLIENT_QUEUE) {
            try {
              controller.close()
            } catch {
              /* already closed */
            }
            closed = true
            return false
          }
          return safeEnqueue(sseFrame(msg))
        },
        close: () => {
          if (!closed) {
            try {
              controller.close()
            } catch {
              /* already closed */
            }
            closed = true
          }
        },
      })

      // client disconnect (browser close / network drop)
      req.signal.addEventListener('abort', () => {
        closed = true
        try {
          controller.close()
        } catch {
          /* already closed */
        }
        unsubscribe?.()
      })
    },
    cancel() {
      unsubscribe?.()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
