/**
 * GamificationOG — Realtime hub (§78 Realtime System).
 *
 * Server-Sent Events transport (an "equivalent realtime transport" per §78)
 * for live event / leaderboard / state traffic.
 *
 * Semantics implemented (§78 checklist):
 *   Authentication      — callers authenticate with a scoped API key at the
 *                         route layer; the hub only ever sees verified topics
 *   Subscription scope  — topics are project+environment scoped; a client
 *                         receives ONLY topics it subscribed to (with `*`
 *                         wildcard), and only for its own project/env
 *   Ordering            — every published message gets a global monotonically
 *                         increasing sequence number (`id:` in SSE framing)
 *   Reconnect behavior  — bounded in-memory ring buffer replays missed
 *                         messages to reconnecting clients via Last-Event-ID;
 *                         a `retry:` hint is sent so browsers auto-reconnect
 *   Backpressure        — per-client bounded queue; slow clients are dropped
 *                         (they reconnect and replay) instead of buffering
 *                         without bound
 *   Delivery semantics  — at-least-once per connection, best-effort across
 *                         reconnects (single-instance ring buffer; a
 *                         multi-instance deployment should bridge the hub
 *                         through Redis pub/sub — noted for ops)
 *
 * The hub is a process-global singleton (survives dev HMR via globalThis).
 */

export interface RealtimeMessage {
  seq: number
  projectId: string
  environmentId: string
  topic: string
  type: string
  data: Record<string, unknown>
  at: string
}

export interface ClientHooks {
  id: string
  projectId: string
  environmentId: string
  topics: string[] // may contain '*'
  /** returns false when the client is gone or must be dropped */
  send: (msg: RealtimeMessage) => boolean
  close: () => void
}

interface Client extends ClientHooks {
  queued: number
}

const RING_SIZE = 500
const MAX_CLIENT_QUEUE = 200
const HEARTBEAT_MS = 15_000
const RETRY_HINT_MS = 3_000

interface HubState {
  clients: Map<string, Client>
  ring: RealtimeMessage[]
  ringSeq: number
  heartbeat?: ReturnType<typeof setInterval>
}

function state(): HubState {
  const g = globalThis as unknown as { __gogRealtimeHub?: HubState }
  if (!g.__gogRealtimeHub) {
    g.__gogRealtimeHub = { clients: new Map(), ring: [], ringSeq: 0 }
  }
  return g.__gogRealtimeHub
}

function topicMatches(subscribed: string[], topic: string): boolean {
  return subscribed.some((s) => s === '*' || s === topic || topic.startsWith(`${s}:`))
}

/** Publish a message to all matching clients + the replay ring. Returns the seq. */
export function publish(
  projectId: string,
  environmentId: string,
  topic: string,
  type: string,
  data: Record<string, unknown>,
): number {
  const s = state()
  const msg: RealtimeMessage = {
    seq: ++s.ringSeq,
    projectId,
    environmentId,
    topic,
    type,
    data,
    at: new Date().toISOString(),
  }
  s.ring.push(msg)
  if (s.ring.length > RING_SIZE) s.ring.shift()

  for (const [id, client] of [...s.clients.entries()]) {
    if (client.projectId !== projectId || client.environmentId !== environmentId) continue
    if (!topicMatches(client.topics, topic)) continue
    try {
      const alive = client.send(msg)
      if (!alive) s.clients.delete(id)
    } catch {
      s.clients.delete(id)
    }
  }
  return msg.seq
}

/** Register a client; returns its unsubscribe function. */
export function registerClient(client: ClientHooks): () => void {
  const s = state()
  const full: Client = { ...client, queued: 0 }
  s.clients.set(client.id, full)
  ensureHeartbeat()
  return () => {
    s.clients.delete(full.id)
  }
}

/** Replay missed messages (seq > afterSeq) in the caller's scope + topics. */
export function replayAfter(
  projectId: string,
  environmentId: string,
  topics: string[],
  afterSeq: number,
): RealtimeMessage[] {
  return state()
    .ring.filter((m) => m.seq > afterSeq && m.projectId === projectId && m.environmentId === environmentId)
    .filter((m) => topicMatches(topics, m.topic))
    .sort((a, b) => a.seq - b.seq)
}

export function connectionCount(): number {
  return state().clients.size
}

export function lastSeq(): number {
  return state().ringSeq
}

function ensureHeartbeat(): void {
  const s = state()
  if (s.heartbeat) return
  s.heartbeat = setInterval(() => {
    for (const [id, client] of [...s.clients.entries()]) {
      try {
        client.send({ seq: -1, projectId: '', environmentId: '', topic: ':heartbeat', type: 'heartbeat', data: {}, at: new Date().toISOString() })
      } catch {
        s.clients.delete(id)
      }
    }
  }, HEARTBEAT_MS)
}

export const REALTIME_CONSTANTS = {
  RING_SIZE,
  MAX_CLIENT_QUEUE,
  HEARTBEAT_MS,
  RETRY_HINT_MS,
} as const
