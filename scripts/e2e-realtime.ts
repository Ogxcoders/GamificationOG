/**
 * GamificationOG — E2E REALTIME suite (§78 Realtime System).
 * Covers: SSE stream auth (401/403), hello handshake + retry hint, live
 * event.processed messages with state deltas, leaderboard.update topic
 * fan-out, topic filtering (subscription scope), ordering (monotonic seq),
 * reconnect with Last-Event-ID replay, replay isolation during §102
 * rebuild (no live stream traffic), invalid topic validation.
 *
 * Usage: bun scripts/e2e-realtime.ts [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://localhost:3000'
const TS = Date.now()

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
  if (opts.cookie) headers.cookie = opts.cookie
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const setCookie = res.headers.get('set-cookie') ?? ''
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* non-json */
  }
  return { status: res.status, json, setCookie, headers: res.headers }
}

/**
 * Minimal SSE client: opens the stream, parses frames, exposes a queue the
 * test polls. autoClose aborts after N ms.
 */
class SseClient {
  frames: Array<{ event: string; data: any; id?: string; raw: string }> = []
  private controller: AbortController
  done = false
  lastEventId = ''

  constructor(
    private url: string,
    opts: { headers?: Record<string, string>; autoCloseMs?: number } = {},
  ) {
    this.controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch(this.url, {
          headers: { accept: 'text/event-stream', ...(opts.headers ?? {}) },
          signal: this.controller.signal,
        })
        if (res.status !== 200 || !res.body) {
          this.frames.push({ event: 'http_error', data: { status: res.status }, raw: '' })
          this.done = true
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        const timer = opts.autoCloseMs ? setTimeout(() => this.close(), opts.autoCloseMs) : null
        while (true) {
          const { value, done: streamDone } = await reader.read()
          if (streamDone) break
          buffer += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            const frame = this.parseFrame(raw)
            if (frame) {
              this.frames.push(frame)
              if (frame.id) this.lastEventId = frame.id
            }
          }
        }
        if (timer) clearTimeout(timer)
      } catch {
        /* aborted */
      } finally {
        this.done = true
      }
    })()
  }

  private parseFrame(raw: string) {
    let event = 'message'
    let data = ''
    let id: string | undefined
    let hasData = false
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue // comment / heartbeat
      if (line.startsWith('retry:')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) {
        data = line.slice(5).trim()
        hasData = true
      }
      if (line.startsWith('id:')) id = line.slice(3).trim()
    }
    if (!hasData) return null // pure comment frame (heartbeat / retry hint)
    try {
      return { event, data: JSON.parse(data), id, raw }
    } catch {
      return { event, data, id, raw }
    }
  }

  close() {
    this.controller.abort()
  }

  async waitFor(pred: (f: { event: string; data: any }) => boolean, timeoutMs = 8000): Promise<any | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = this.frames.find((f) => pred(f))
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }
}

console.log('\n════════════ GamificationOG — E2E REALTIME (§78) ════════════')
console.log(`Target: ${BASE}\n`)

// ---------- 0. Login + keys ----------
let SID = ''
let APIKEY = ''
let WRITEONLY_KEY = ''
{
  const login = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  check('owner login works', login.status === 200)
  SID = login.setCookie.split(';')[0]

  const created = await call('/api/admin/apikeys/list', {
    cookie: SID,
    method: 'POST',
    body: { name: `e2e-rt-${TS}`, scopes: ['events:write', 'events:read', 'state:read'] },
  })
  APIKEY = created.json?.key?.key ?? ''
  check('stream key created (events:read)', created.status === 201 && !!APIKEY)

  const wo = await call('/api/admin/apikeys/list', {
    cookie: SID,
    method: 'POST',
    body: { name: `e2e-rt-wo-${TS}`, scopes: ['events:write'] },
  })
  WRITEONLY_KEY = wo.json?.key?.key ?? ''
}

async function sendEvent(user: string, type: string, payload: Record<string, unknown>) {
  return call('/api/v1/events', {
    method: 'POST',
    headers: { authorization: `Bearer ${APIKEY}` },
    body: { external_user_id: user, event_type: type, payload },
  })
}

// ---------- 1. Auth gates ----------
console.log('\n▸ 1. Stream authentication')
{
  const anon = new SseClient(`${BASE}/api/v1/stream`, { autoCloseMs: 1500 })
  await new Promise((r) => setTimeout(r, 1800))
  const errFrame = anon.frames.find((f) => f.event === 'http_error')
  check('no API key → 401', errFrame?.data?.status === 401, `status ${errFrame?.data?.status}`)

  const wrongScope = new SseClient(`${BASE}/api/v1/stream`, {
    headers: { authorization: `Bearer ${WRITEONLY_KEY}` },
    autoCloseMs: 1500,
  })
  await new Promise((r) => setTimeout(r, 1800))
  const errFrame2 = wrongScope.frames.find((f) => f.event === 'http_error')
  check('key without events:read → 401 SCOPE_MISSING (platform convention)', errFrame2?.data?.status === 401, `status ${errFrame2?.data?.status}`)

  const badTopics = new SseClient(`${BASE}/api/v1/stream?topics=!!!`, {
    headers: { authorization: `Bearer ${APIKEY}` },
    autoCloseMs: 1500,
  })
  await new Promise((r) => setTimeout(r, 1800))
  const errFrame3 = badTopics.frames.find((f) => f.event === 'http_error')
  check('invalid topic characters → 400', errFrame3?.data?.status === 400, `status ${errFrame3?.data?.status}`)

  // query-param key auth (browser EventSource pattern — SDK stream() helper)
  const viaQuery = new SseClient(`${BASE}/api/v1/stream?topics=events&key=${APIKEY}`, { autoCloseMs: 4000 })
  const helloQ = await viaQuery.waitFor((f) => f.event === 'hello', 5000)
  check('API key via ?key= query param authenticates (EventSource pattern)', !!helloQ)
  viaQuery.close()
  const viaBadQuery = new SseClient(`${BASE}/api/v1/stream?key=gog_invalid`, { autoCloseMs: 1500 })
  await new Promise((r) => setTimeout(r, 1800))
  const errFrame4 = viaBadQuery.frames.find((f) => f.event === 'http_error')
  check('invalid ?key= rejected', errFrame4?.data?.status === 401, `status ${errFrame4?.data?.status}`)
}

// ---------- 2. Hello handshake + live traffic ----------
console.log('\n▸ 2. Hello handshake and live event fan-out')
const USER = `rt-user-${TS}`
{
  await call('/api/v1/identify', {
    method: 'POST',
    headers: { authorization: `Bearer ${APIKEY}` },
    body: { external_id: USER, display_name: USER },
  })

  const client = new SseClient(`${BASE}/api/v1/stream?topics=events,leaderboard`, {
    headers: { authorization: `Bearer ${APIKEY}` },
    autoCloseMs: 12000,
  })
  const hello = await client.waitFor((f) => f.event === 'hello')
  check('hello handshake received', !!hello, hello ? `topics=${JSON.stringify(hello.data.topics)}` : 'missing')
  check('hello reports retry hint', hello?.data?.retryMs === 3000, `retryMs=${hello?.data?.retryMs}`)
  check('hello reports heartbeat interval', hello?.data?.heartbeatMs === 15000)
  check('hello carries connectionId', typeof hello?.data?.connectionId === 'string' && hello.data.connectionId.length > 0)

  const evt = await sendEvent(USER, 'task.completed', { title: 'live one', difficulty: 'hard' })
  check('source event processed', evt.json?.status === 'processed')

  const live = await client.waitFor((f) => f.event === 'message' && f.data?.type === 'event.processed' && f.data?.data?.eventId === evt.json?.eventId, 10000)
  check('event.processed message streamed with matching eventId', !!live, live ? `seq=${live.data.seq} xp=${live.data.data.xpAwarded}` : 'missing')
  check('streamed message carries topic "events"', live?.data?.topic === 'events')
  check('streamed message carries state delta (xpAwarded)', typeof live?.data?.data?.xpAwarded === 'number' && live.data.data.xpAwarded > 0, `xp=${live?.data?.data?.xpAwarded}`)
  check('streamed message carries trace id', typeof live?.data?.data?.traceId === 'string')

  const lb = await client.waitFor(
    (f) => f.event === 'message' && f.data?.type === 'leaderboard.update' && f.data?.data?.eventId === evt.json?.eventId,
    8000,
  )
  check('leaderboard.update streamed for the same event', !!lb, lb ? `topic=${lb.data.topic} score=${lb.data.data.score}` : 'missing')
  check('leaderboard topic uses leaderboard:<name> prefix', typeof lb?.data?.topic === 'string' && lb.data.topic.startsWith('leaderboard:'))

  // ordering: seqs strictly increasing across the messages we got
  const seqs = client.frames.filter((f) => f.event === 'message' && typeof f.data?.seq === 'number').map((f) => f.data.seq as number)
  const increasing = seqs.every((s, i) => i === 0 || s > seqs[i - 1])
  check('message seq numbers are strictly increasing', seqs.length >= 2 && increasing, seqs.join(','))
  client.close()

  // ---------- 3. Topic filtering (subscription scope) ----------
  console.log('\n▸ 3. Topic filtering')
  const eventsOnly = new SseClient(`${BASE}/api/v1/stream?topics=events`, {
    headers: { authorization: `Bearer ${APIKEY}` },
    autoCloseMs: 6000,
  })
  await eventsOnly.waitFor((f) => f.event === 'hello')
  const evt2 = await sendEvent(USER, 'task.completed', { title: 'filtered', difficulty: 'easy' })
  const gotEvent = await eventsOnly.waitFor((f) => f.data?.data?.eventId === evt2.json?.eventId, 6000)
  check('events-only subscription receives event.processed', !!gotEvent)
  const gotLb = await eventsOnly.waitFor(
    (f) => f.data?.type === 'leaderboard.update' && f.data?.data?.eventId === evt2.json?.eventId,
    2500,
  )
  check('events-only subscription does NOT receive leaderboard.update', !gotLb)
  eventsOnly.close()

  // ---------- 4. Reconnect + Last-Event-ID replay ----------
  console.log('\n▸ 4. Reconnect with Last-Event-ID replay')
  const lastSeqBefore = seqs.length ? seqs[seqs.length - 1] : 0
  // generate 3 events while disconnected
  const offlineIds: string[] = []
  for (let i = 0; i < 3; i++) {
    const e = await sendEvent(USER, 'task.completed', { title: `offline ${i}`, difficulty: 'medium' })
    offlineIds.push(e.json?.eventId)
  }
  const reconnected = new SseClient(`${BASE}/api/v1/stream?topics=events,leaderboard&last_event_id=${lastSeqBefore}`, {
    headers: { authorization: `Bearer ${APIKEY}`, 'last-event-id': String(lastSeqBefore) },
    autoCloseMs: 8000,
  })
  await reconnected.waitFor((f) => f.event === 'hello')
  let replayed = 0
  for (const id of offlineIds) {
    const got = await reconnected.waitFor((f) => f.data?.data?.eventId === id, 6000)
    if (got) replayed++
  }
  check('missed messages replayed after reconnect (Last-Event-ID)', replayed === offlineIds.length, `${replayed}/${offlineIds.length}`)
  const replaySeqs = reconnected.frames.filter((f) => typeof f.data?.seq === 'number').map((f) => f.data.seq as number)
  check('replayed seqs all exceed the Last-Event-ID', replaySeqs.every((s) => s > lastSeqBefore), `lastId=${lastSeqBefore} min=${Math.min(...replaySeqs)}`)
  reconnected.close()
}

// ---------- 5. Replay isolation (§102 × §78) ----------
console.log('\n▸ 5. §102 rebuild does not emit realtime traffic')
{
  const watcher = new SseClient(`${BASE}/api/v1/stream?topics=*`, {
    headers: { authorization: `Bearer ${APIKEY}` },
    autoCloseMs: 10000,
  })
  await watcher.waitFor((f) => f.event === 'hello')
  const beforeCount = watcher.frames.filter((f) => f.event === 'message').length

  const rebuild = await call('/api/admin/recovery/replay', {
    cookie: SID,
    body: { external_user_id: USER, dry_run: false },
  })
  check('§102 rebuild succeeds while stream is open', rebuild.status === 200 && rebuild.json?.result?.status === 'completed')

  await new Promise((r) => setTimeout(r, 2500)) // allow any (wrong) fanout to arrive
  const afterCount = watcher.frames.filter((f) => f.event === 'message').length
  check('no realtime messages emitted by the rebuild', afterCount === beforeCount, `${beforeCount} → ${afterCount}`)
  watcher.close()
}

// ---------- 6. Heartbeat ----------
console.log('\n▸ 6. Heartbeat keeps the connection warm')
{
  const hb = new SseClient(`${BASE}/api/v1/stream?topics=events`, {
    headers: { authorization: `Bearer ${APIKEY}` },
    autoCloseMs: 17000,
  })
  await hb.waitFor((f) => f.event === 'hello')
  // heartbeats are SSE comment frames — visible in raw chunks, not parsed frames.
  // We assert the connection is still alive after >15s and no error frames arrived.
  await new Promise((r) => setTimeout(r, 16500))
  const errors = hb.frames.filter((f) => f.event === 'http_error')
  check('connection alive after heartbeat interval (no errors)', errors.length === 0 && !hb.done, `frames=${hb.frames.length}`)
  hb.close()
}

// ---------- summary ----------
console.log('\n──────────── RESULT ────────────')
console.log(`  pass: ${pass}  fail: ${fail}`)
if (failures.length) {
  console.log('  failed checks:')
  for (const f of failures) console.log(`    - ${f}`)
  process.exit(1)
}
process.exit(0)
