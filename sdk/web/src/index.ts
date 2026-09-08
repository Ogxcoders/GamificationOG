/**
 * GamificationOG Web SDK (Section 82).
 * Zero-dependency TypeScript client for the public v1 API.
 *
 * Features:
 *  - identify users (anonymous or named)
 *  - track events with automatic correlation + idempotency keys
 *  - offline queue with localStorage persistence + batch flush
 *  - user state snapshots (progression, wallets, achievements, challenges)
 *  - leaderboards with "around me" context
 *  - feature flags / experiments / remote config
 *
 * Golden path (Customer Zero):
 *   const gog = new GamificationOG({ apiKey: 'gog_...' })
 *   await gog.identify('user_123', { plan: 'free' })
 *   const res = await gog.track('task.completed', { difficulty: 'hard' })
 *   // res.stateDelta → XP, level ups, currency, achievements, streak
 */

export interface GamificationOGOptions {
  /** Public API key (gog_...) from Settings. */
  apiKey: string
  /** Base URL of the GamificationOG deployment. Default: current origin. */
  baseUrl?: string
  /** External user id. Can also be set via identify(). */
  userId?: string
  /** Flush interval for the offline queue (ms). Default: 10000. */
  flushInterval?: number
  /** Max queued events before forced flush. Default: 50. */
  maxQueueSize?: number
  /** Storage key for the offline queue. Set to null to disable persistence. */
  storageKey?: string | null
}

export interface TrackOptions {
  /** Deduplication key — retries with the same key never double-process. */
  idempotencyKey?: string
  /** ISO timestamp of when the event actually happened. */
  occurredAt?: string
  /** Related entity id (e.g. completed lesson id). */
  subjectId?: string
  /** Event source label, e.g. 'web_sdk'. */
  source?: string
}

export interface StateDelta {
  xpAwarded: number
  levelUps: Array<{ track: string; from: number; to: number }>
  currencyChanges: Array<{ currency: string; amount: number; balanceAfter: number }>
  itemsGranted: Array<{ item: string; quantity: number }>
  achievementsUnlocked: Array<{ code: string; name: string }>
  challengesCompleted: Array<{ name: string }>
  streak: { key: string; current: number; best: number } | null
  leaderboardUpdates: Array<{ leaderboard: string; score: number; rank: number | null }>
  notifications: number
}

export interface TrackResult {
  eventId: string
  status: 'processed' | 'failed' | 'duplicate' | 'skipped'
  traceId?: string
  error?: string
  actions: Array<{ action: string; status: string; detail: string }>
  stateDelta: StateDelta
}

export interface UserState {
  user: {
    external_id: string
    display_name: string | null
    anonymous: boolean
    attributes: Record<string, unknown>
  }
  progression: Array<{
    track: string
    trackName: string
    xp: number
    level: number
    maxLevel: number
    xpForNextLevel: number
    progressPercent: number
  }>
  wallets: Array<{ currency: string; balance: number; currencyType: string }>
  inventory: Array<{ code: string; name: string; quantity: number; type: string }>
  achievements: Array<{
    code: string
    name: string
    description: string | null
    unlocked: boolean
    unlockedAt: string | null
    icon: string | null
    progressPercent: number
  }>
  challenges: Array<{
    name: string
    description: string | null
    type: string
    target: number
    progress: number
    completed: boolean
    progressPercent: number
    endsAt: string | null
  }>
  streaks: Array<{ key: string; name: string; cadence: string; current: number; best: number }>
  notifications: Array<{
    id: string
    title: string
    body: string | null
    type: string
    sentAt: string
    readAt: string | null
  }>
  variables: Record<string, unknown>
}

export interface LeaderboardView {
  leaderboard: { code: string; name: string; timeWindow: string; algorithm: string; metricSource: string }
  periodKey: string
  entries: Array<{ rank: number; score: number; user: string; isSelf: boolean }>
  around: { rank: number; score: number; user: string; isSelf: boolean } | null
}

export interface FlagsResult {
  flags: Record<string, boolean>
  experiments: Record<string, string>
  config: Record<string, unknown>
  segments: string[]
}

interface QueuedEvent {
  event_type: string
  external_user_id?: string
  payload: Record<string, unknown>
  idempotency_key?: string
  occurred_at?: string
  subject_id?: string | null
  source: string
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export class GamificationOG {
  private apiKey: string
  private baseUrl: string
  private userId: string | undefined
  private flushInterval: number
  private maxQueueSize: number
  private storageKey: string | null
  private queue: QueuedEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false

  constructor(options: GamificationOGOptions) {
    if (!options.apiKey) throw new Error('GamificationOG: apiKey is required')
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000')).replace(/\/$/, '')
    this.userId = options.userId
    this.flushInterval = options.flushInterval ?? 10000
    this.maxQueueSize = options.maxQueueSize ?? 50
    this.storageKey = options.storageKey ?? 'gog_queue'
    this.restoreQueue()
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /** Identify (or create) a user. Sets the SDK's active user. */
  async identify(externalId: string, traits?: {
    displayName?: string
    anonymous?: boolean
    attributes?: Record<string, unknown>
    mergeFromExternalId?: string
    provider?: string
  }): Promise<{ user_id: string; external_id: string; created: boolean; merged: boolean }> {
    this.userId = externalId
    const res = await this.request<{ user_id: string; external_id: string; created: boolean; merged: boolean }>(
      '/api/v1/identify',
      'POST',
      {
        external_id: externalId,
        display_name: traits?.displayName,
        anonymous: traits?.anonymous ?? false,
        attributes: traits?.attributes,
        merge_from_external_id: traits?.mergeFromExternalId,
        provider: traits?.provider,
      },
    )
    return res
  }

  /** Generate an anonymous id (persisted to localStorage). */
  static anonymousId(): string {
    const key = 'gog_anonymous_id'
    try {
      const existing = localStorage.getItem(key)
      if (existing) return existing
      const id = `anon_${generateId()}`
      localStorage.setItem(key, id)
      return id
    } catch {
      return `anon_${generateId()}`
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Track an event. Returns the full processing result including state
   * deltas (XP earned, achievements unlocked, etc.) and the trace id.
   * Offline events are queued automatically when the request fails.
   */
  async track(eventType: string, payload: Record<string, unknown> = {}, options: TrackOptions = {}): Promise<TrackResult> {
    if (!this.userId) throw new Error('GamificationOG: call identify() before track()')
    const body = {
      event_type: eventType,
      external_user_id: this.userId,
      payload,
      idempotency_key: options.idempotencyKey ?? generateId(),
      occurred_at: options.occurredAt ?? new Date().toISOString(),
      subject_id: options.subjectId ?? null,
      source: options.source ?? 'web_sdk',
    }
    try {
      return await this.request<TrackResult>('/api/v1/events', 'POST', body)
    } catch (e) {
      // offline: queue for later flush
      this.queue.push(body as QueuedEvent)
      this.persistQueue()
      this.scheduleFlush()
      throw e
    }
  }

  /**
   * Track without awaiting the result (fire-and-forget with offline queue).
   * Never throws; failures are queued and retried.
   */
  trackSafe(eventType: string, payload: Record<string, unknown> = {}, options: TrackOptions = {}): void {
    void this.track(eventType, payload, options).catch(() => {
      /* queued for retry */
    })
  }

  // -------------------------------------------------------------------------
  // State reads
  // -------------------------------------------------------------------------

  /** Full user state snapshot for the current (or given) user. */
  async getUserState(externalId?: string): Promise<UserState> {
    const id = externalId ?? this.userId
    if (!id) throw new Error('GamificationOG: no user identified')
    return this.request<UserState>(`/api/v1/users/${encodeURIComponent(id)}/state`, 'GET')
  }

  /** Leaderboard view with optional "around me". */
  async getLeaderboard(code: string, limit = 100, aroundUser?: string): Promise<LeaderboardView> {
    const params = new URLSearchParams({ code: String(code), limit: String(limit) })
    const user = aroundUser ?? this.userId
    if (user) params.set('user', user)
    return this.request<LeaderboardView>(`/api/v1/leaderboards?${params.toString()}`, 'GET')
  }

  /** Feature flags + experiment variants + remote config + segments. */
  async getFlags(externalId?: string): Promise<FlagsResult> {
    const id = externalId ?? this.userId
    if (!id) throw new Error('GamificationOG: no user identified')
    return this.request<FlagsResult>(`/api/v1/flags?user=${encodeURIComponent(id)}`, 'GET')
  }

  // -------------------------------------------------------------------------
  // Offline queue
  // -------------------------------------------------------------------------

  /** Flush all queued events (batched). Returns count flushed. */
  async flush(): Promise<number> {
    if (this.flushing || this.queue.length === 0) return 0
    this.flushing = true
    let flushed = 0
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, 25)
        await this.request('/api/v1/events', 'POST', { events: batch })
        flushed += batch.length
        this.persistQueue()
      }
    } finally {
      this.flushing = false
    }
    return flushed
  }

  /** Number of events currently queued. */
  get queueSize(): number {
    return this.queue.length
  }

  /** Start the automatic flush timer. */
  startAutoFlush(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.flush().catch(() => null)
    }, this.flushInterval)
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      ;(this.timer as unknown as { unref: () => void }).unref()
    }
  }

  /** Stop the automatic flush timer. */
  stopAutoFlush(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private scheduleFlush(): void {
    if (this.queue.length >= this.maxQueueSize) {
      void this.flush().catch(() => null)
    } else {
      this.startAutoFlush()
    }
  }

  private persistQueue(): void {
    if (this.storageKey === null) return
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.queue))
    } catch {
      /* storage unavailable — queue lives in memory */
    }
  }

  private restoreQueue(): void {
    if (this.storageKey === null) return
    try {
      const raw = localStorage.getItem(this.storageKey)
      if (raw) this.queue = JSON.parse(raw) as QueuedEvent[]
    } catch {
      this.queue = []
    }
    // flush any backlog from a previous session
    if (this.queue.length > 0) {
      // wait a tick so the app can identify first
      setTimeout(() => void this.flush().catch(() => null), 1000)
    }
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as T & {
      error?: { code: string; message: string; fix?: string; detail?: string; trace_id?: string }
    }
    if (!res.ok) {
      const err = new Error(data?.error?.message ?? `GamificationOG request failed (${res.status})`) as Error & {
        code?: string
        fix?: string
        traceId?: string
      }
      err.code = data?.error?.code
      err.fix = data?.error?.fix
      err.traceId = data?.error?.trace_id
      throw err
    }
    return data as T
  }
}

export default GamificationOG
