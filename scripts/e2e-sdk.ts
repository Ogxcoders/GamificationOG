/**
 * GamificationOG — Web SDK end-to-end test.
 * Imports the ACTUAL SDK (sdk/web/src/index.ts) and exercises the full
 * client surface: identify, track (with state deltas + trace ids),
 * idempotency, state reads, leaderboards, flags, offline queue with
 * localStorage persistence, batch flush recovery, error contract.
 *
 * Usage: bun scripts/e2e-sdk.ts [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://localhost:3000'

// ---- in-memory localStorage stub (bun has no DOM) ----
const mem = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => mem.set(k, String(v)),
  removeItem: (k: string) => mem.delete(k),
  clear: () => mem.clear(),
}

const { default: GamificationOG } = await import('../sdk/web/src/index')

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

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@focusquest.app', password: 'gamification123' }),
  })
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

async function createKey(sid: string): Promise<{ id: string; secret: string }> {
  const res = await fetch(`${BASE}/api/admin/apikeys/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sid },
    body: JSON.stringify({ name: 'E2E SDK key', scopes: ['events:write', 'state:read'] }),
  })
  const j: any = await res.json()
  return { id: j.key.id, secret: j.key.key }
}

console.log('\n══════════ GamificationOG — WEB SDK E2E ══════════\n')

const SID = await login()
const KEY = await createKey(SID)
const USER = `sdk_user_${Date.now().toString(36).slice(-5)}`

// 1. constructor contract
{
  let threw = false
  try {
    new (GamificationOG as any)({ apiKey: '' })
  } catch {
    threw = true
  }
  check('constructor requires apiKey', threw)
}

const sdk = new GamificationOG({ apiKey: KEY.secret, baseUrl: BASE, flushInterval: 60000 })

// 2. identify
{
  const res = await sdk.identify(USER, { displayName: 'SDK Tester', attributes: { plan: 'pro', source: 'e2e-sdk' } })
  check('identify creates user', res.created === true && !!res.user_id, `user_id ${res.user_id.slice(0, 8)}…`)
  const again = await sdk.identify(USER)
  check('identify idempotent', again.created === false && again.user_id === res.user_id)

  const anon = GamificationOG.anonymousId()
  const anon2 = GamificationOG.anonymousId()
  check('anonymousId generated + persisted', anon.startsWith('anon_') && anon === anon2, anon.slice(0, 18) + '…')
}

// 3. track with full result
{
  const r = await sdk.track('task.completed', { difficulty: 'hard', count: 1 })
  check(
    'track returns full processing result',
    r.status === 'processed' && r.stateDelta?.xpAwarded === 50 && !!r.traceId && Array.isArray(r.actions),
    `+${r.stateDelta?.xpAwarded} XP, ${r.actions?.length} actions, trace ${r.traceId?.slice(0, 8)}…`,
  )

  // idempotency via explicit key
  const key = `sdk-idem-${Date.now()}`
  const a = await sdk.track('task.completed', { difficulty: 'easy', count: 1 }, { idempotencyKey: key })
  const b = await sdk.track('task.completed', { difficulty: 'easy', count: 1 }, { idempotencyKey: key })
  check('SDK idempotencyKey honored (replay deduped)', a.status === 'processed' && b.status === 'duplicate')

  // track without identify → throws
  const fresh = new GamificationOG({ apiKey: KEY.secret, baseUrl: BASE, storageKey: null })
  let threw = false
  try {
    await fresh.track('task.completed', {})
  } catch (e: any) {
    threw = String(e?.message ?? e).includes('identify')
  }
  check('track before identify throws helpful error', threw)
}

// 4. state reads through the SDK
{
  const state = await sdk.getUserState()
  check(
    'getUserState (active user) returns aggregate',
    state.user?.external_id === USER && (state.progression?.[0]?.xp ?? 0) > 0,
    `xp=${state.progression?.[0]?.xp}, level=${state.progression?.[0]?.level}, coins=${state.wallets?.find((w: any) => w.currency === 'coins')?.balance}`,
  )

  const lb = await sdk.getLeaderboard('all_time_xp', 10)
  check(
    'getLeaderboard (around me)',
    (lb.entries?.length ?? 0) > 0 && typeof lb.entries[0]?.rank === 'number' && !!lb.around,
    `${lb.entries?.length} entries, me: #${lb.around?.rank} (${lb.around?.score})`,
  )

  const flags = await sdk.getFlags()
  check(
    'getFlags returns flags + experiments + config',
    !!flags.flags?.season_one && !!flags.config?.daily_xp_cap && !!flags.experiments,
    `flags: ${Object.entries(flags.flags ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')}`,
  )
}

// 5. trackSafe (fire-and-forget)
{
  sdk.trackSafe('task.completed', { difficulty: 'medium', count: 1 })
  await new Promise((r) => setTimeout(r, 800))
  const state = await sdk.getUserState()
  check('trackSafe sends in background', (state.progression?.[0]?.xp ?? 0) >= 100, `xp=${state.progression?.[0]?.xp}`)
}

// 6. offline queue: dead server → queue → localStorage → new SDK → flush
{
  const OFFLINE_KEY = `gog_queue_sdk_test`
  const dead = new GamificationOG({ apiKey: KEY.secret, baseUrl: 'http://localhost:9', storageKey: OFFLINE_KEY, flushInterval: 60000 })
  await dead.identify(USER).catch(() => null) // will fail — fine, identity already known server-side

  let queued = 0
  for (let i = 0; i < 3; i++) {
    try {
      await dead.track('task.completed', { difficulty: 'easy', count: 1 })
    } catch {
      queued++
    }
  }
  check('offline track failures are queued (not lost)', queued === 3 && dead.queueSize === 3, `queueSize=${dead.queueSize}`)
  const persisted = mem.get(OFFLINE_KEY)
  check('queue persisted to localStorage', !!persisted && JSON.parse(persisted).length === 3, `${JSON.parse(persisted ?? '[]').length} events persisted`)

  // fresh SDK with live URL restores the queue and flushes it
  const live = new GamificationOG({ apiKey: KEY.secret, baseUrl: BASE, storageKey: OFFLINE_KEY, flushInterval: 60000 })
  // restoreQueue schedules a flush in 1s; also flush explicitly
  await new Promise((r) => setTimeout(r, 1400))
  const flushed = await live.flush()
  await new Promise((r) => setTimeout(r, 300))
  check('restored queue flushed to live server', flushed > 0 || live.queueSize === 0, `flushed=${flushed}, remaining=${live.queueSize}`)

  // verify the recovered events actually landed
  const feed: any = await (
    await fetch(`${BASE}/api/admin/events/feed?limit=50&`, { headers: { cookie: SID } })
  ).json()
  const recovered = (feed.events ?? []).filter(
    (e: any) => e.source === 'web_sdk' && e.user === 'SDK Tester' && e.type === 'task.completed',
  )
  check('offline-recovered events present in server feed', recovered.length >= 4, `${recovered.length} web_sdk events on server`)
  check('queue drained from storage', live.queueSize === 0)
}

// 7. error contract
{
  const badSdk = new GamificationOG({ apiKey: 'gog_invalid', baseUrl: BASE, storageKey: null })
  let err: any = null
  try {
    await badSdk.identify(USER)
  } catch (e: any) {
    err = e
  }
  check('invalid key raises structured error', !!err && (err.status === 401 || err.code === 'UNAUTHORIZED' || String(err.message).includes('401') || String(err.message).toLowerCase().includes('invalid')), String(err?.message ?? err).slice(0, 80))
}

// cleanup: revoke key
{
  const res = await fetch(`${BASE}/api/admin/apikeys/list?id=${KEY.id}`, { method: 'DELETE', headers: { cookie: SID } })
  const j: any = await res.json()
  check('SDK test key revoked', j.revoked === true)
}

console.log('\n════════════════════════════════════════════════════════════════')
console.log(`  RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(`  Failed: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('  🎉 ALL WEB SDK E2E CHECKS PASSED.')
process.exit(0)
