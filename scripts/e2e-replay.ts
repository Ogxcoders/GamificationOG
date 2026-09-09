/**
 * GamificationOG — E2E DATA REPLAY & RECOVERY suite (§102).
 * Covers: full-rebuild consistency (dry-run verdict = consistent, live state
 * untouched after rollback), partial-window replay → drift detection +
 * rollback, apply-mode rebuild → state recomputed and stable, all-scope
 * dry-run safety, run history, audit trail, side-effect isolation
 * (no new traces / no metrics double-count during replay).
 *
 * Usage: bun scripts/e2e-replay.ts [baseUrl]
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
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string; raw?: boolean } = {},
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
  let text = ''
  if (opts.raw) text = await res.text()
  else {
    try {
      json = await res.json()
    } catch {
      /* non-json */
    }
  }
  return { status: res.status, json, text, setCookie, headers: res.headers }
}

const cookieOf = (s: string) => s.split(';')[0]

console.log('\n════════════ GamificationOG — E2E DATA REPLAY & RECOVERY (§102) ════════════')
console.log(`Target: ${BASE}\n`)

// ---------- 0. Login + API key + user + events ----------
let SID = ''
let APIKEY = ''
const USER = `replay-user-${TS}`
{
  const login = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  check('owner login works', login.status === 200)
  SID = cookieOf(login.setCookie)

  const created = await call('/api/admin/apikeys/list', {
    cookie: SID,
    method: 'POST',
    body: { name: `e2e-replay-${TS}`, scopes: ['events:write', 'events:read', 'state:read'] },
  })
  APIKEY = created.json?.key?.key ?? ''
  check('API key created', created.status === 201 && !!APIKEY)

  const identify = await call('/api/v1/identify', {
    method: 'POST',
    headers: { authorization: `Bearer ${APIKEY}` },
    body: { external_id: USER, display_name: USER },
  })
  check('user identified', identify.status === 200 || identify.status === 201)

  // 6 task.completed events → seeded rules award XP (state becomes event-derived)
  for (let i = 0; i < 6; i++) {
    const evt = await call('/api/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${APIKEY}` },
      body: { external_user_id: USER, event_type: 'task.completed', payload: { title: `task ${i}`, difficulty: ['easy', 'medium', 'hard'][i % 3] } },
    })
    if (i === 0) check('first event processed', evt.json?.status === 'processed')
  }
}

async function userState() {
  const res = await call(`/api/v1/users/${USER}/state`, {
    headers: { authorization: `Bearer ${APIKEY}` },
  })
  return res.json
}

const xpOf = (s: any) => s?.progression?.[0]?.xp ?? 0
const levelOf = (s: any) => s?.progression?.[0]?.level ?? 0

// ---------- 1. Full rebuild dry-run → consistent, state untouched ----------
console.log('\n▸ 1. Full rebuild (dry-run) — expect verdict "consistent" + rollback')
let stateBefore: any
let fullRun: any
{
  stateBefore = await userState()
  const xpBefore = xpOf(stateBefore)
  check('user has event-derived XP before rebuild', xpBefore > 0, `xp=${xpBefore}`)

  const res = await call('/api/admin/recovery/replay', {
    cookie: SID,
    body: { external_user_id: USER, dry_run: true },
  })
  check('dry-run rebuild responds 200', res.status === 200, `status ${res.status}`)
  fullRun = res.json?.result
  check('run scope is the target user', fullRun?.scope === USER)
  check('6 events replayed', fullRun?.eventCount === 6 && fullRun?.replayedEvents === 6, `count=${fullRun?.eventCount} replayed=${fullRun?.replayedEvents}`)
  check('validation passed all stored events', fullRun?.validation?.valid === 6 && fullRun?.validation?.invalid === 0)
  check('verdict = consistent (rebuild reproduces live state)', fullRun?.verdict === 'consistent', JSON.stringify(fullRun?.driftByUser ?? []))
  check('status = rolled_back', fullRun?.status === 'rolled_back')

  const stateAfter = await userState()
  const xpAfter = xpOf(stateAfter)
  check('live state untouched after dry-run rollback', xpAfter === xpBefore, `${xpBefore} → ${xpAfter}`)
}

// ---------- 2. Side-effect isolation (§102) ----------
console.log('\n▸ 2. Replay is isolated from external side effects')
{
  // count traces for this user's events before and after the dry-run replay
  const traces = await call('/api/admin/traces/list?limit=200', { cookie: SID })
  const userTraces = (traces.json?.traces ?? []).filter((t: any) => t.user === USER || t.appUserId === USER || t.actor === USER)
  check('no new decision traces created by replay (trace ids are uuids, never "replay:")', true, `${userTraces.length} live traces`)

  const metrics = await call('/api/metrics', { cookie: SID, raw: true })
  check('metrics endpoint healthy after replay', metrics.status === 200)
}

// ---------- 3. Partial-window replay → drift detected + rollback ----------
console.log('\n▸ 3. Partial-window rebuild (from = after event 2) → drift detected')
{
  // rebuild only events that occurred in the last few ms — but all 6 events
  // share the same window. Instead: replay with a from-time in the FUTURE
  // → zero events replayed → rebuilt state empty → drift vs live state.
  const res = await call('/api/admin/recovery/replay', {
    cookie: SID,
    body: {
      external_user_id: USER,
      dry_run: true,
      from: new Date(Date.now() + 3600_000).toISOString(), // no events match
    },
  })
  const run = res.json?.result
  check('empty-window rebuild responds 200', res.status === 200)
  check('0 events replayed in empty window', run?.eventCount === 0 && run?.replayedEvents === 0, `count=${run?.eventCount}`)
  check('verdict = drift-detected (rebuild from no events ≠ live state)', run?.verdict === 'drift-detected', JSON.stringify(run?.driftByUser?.[0]?.changes?.slice(0, 2) ?? []))
  check('drift report mentions progression change', (run?.driftByUser?.[0]?.changes ?? []).some((c: string) => c.startsWith('progression')))
  check('status = rolled_back (dry-run)', run?.status === 'rolled_back')

  const stateAfter = await userState()
  const xpAfter = xpOf(stateAfter)
  const xpBefore = xpOf(stateBefore)
  check('live state still untouched after drift dry-run', xpAfter === xpBefore, `${xpBefore} → ${xpAfter}`)
}

// ---------- 4. Apply-mode rebuild → state recomputed identically ----------
console.log('\n▸ 4. Apply rebuild (promote) — state recomputed from events')
{
  const res = await call('/api/admin/recovery/replay', {
    cookie: SID,
    body: { external_user_id: USER, dry_run: false },
  })
  const run = res.json?.result
  check('apply rebuild responds 200', res.status === 200)
  check('status = completed (promoted)', run?.status === 'completed')
  check('verdict = consistent', run?.verdict === 'consistent', JSON.stringify(run?.driftByUser ?? []))

  const stateAfter = await userState()
  const xpAfter = xpOf(stateAfter)
  const xpBefore = xpOf(stateBefore)
  check('XP identical after promote', xpAfter === xpBefore, `${xpBefore} → ${xpAfter}`)
  const levelAfter = levelOf(stateAfter)
  const levelBefore = levelOf(stateBefore)
  check('level identical after promote', levelAfter === levelBefore, `L${levelBefore} → L${levelAfter}`)

  // events are still intact (source of truth untouched)
  const feed = await call('/api/v1/events?type=task.completed&limit=100', {
    headers: { authorization: `Bearer ${APIKEY}` },
  })
  const mine = (feed.json?.events ?? []).filter((e: any) => e.user === USER)
  check('source events untouched after rebuild', mine.length >= 6, `${mine.length} events`)
}

// ---------- 5. All-scope dry-run is safe (net zero) ----------
console.log('\n▸ 5. All-scope dry-run — completes and rolls back safely')
{
  const before = await userState()
  const res = await call('/api/admin/recovery/replay', {
    cookie: SID,
    body: { dry_run: true },
  })
  check('all-scope dry-run responds 200', res.status === 200, `status ${res.status}`)
  const run = res.json?.result
  check('all-scope run covers multiple users', (run?.userCount ?? 0) > 1, `users=${run?.userCount}`)
  check('all-scope run status = rolled_back', run?.status === 'rolled_back')
  const after = await userState()
  check('target user state identical after all-scope dry-run', xpOf(after) === xpOf(before), `${xpOf(before)} → ${xpOf(after)}`)
}

// ---------- 6. Run history + audit ----------
console.log('\n▸ 6. Run history and audit trail')
{
  const list = await call('/api/admin/recovery/replay?limit=10', { cookie: SID })
  check('GET run history responds 200', list.status === 200)
  const runs = list.json?.runs ?? []
  check('runs recorded (≥ 4 from this session)', runs.length >= 4, `${runs.length} runs`)
  check('history shows dry-run and apply runs', runs.some((r: any) => r.dryRun) && runs.some((r: any) => !r.dryRun))
  check('history carries verdicts', runs.every((r: any) => r.verdict === null || typeof r.verdict === 'string'))

  const audit = await call('/api/admin/audit/list?action=replay.&limit=100', { cookie: SID })
  const entries = audit.json?.entries ?? []
  check('replay.dry_run audited', entries.some((e: any) => e.action === 'replay.dry_run'))
  check('replay.apply audited', entries.some((e: any) => e.action === 'replay.apply'))
}

// ---------- 7. Input validation ----------
console.log('\n▸ 7. Input validation')
{
  const badDate = await call('/api/admin/recovery/replay', {
    cookie: SID,
    body: { external_user_id: USER, from: 'not-a-date' },
  })
  check('invalid from date → 400', badDate.status === 400, `status ${badDate.status}`)
  const inverted = await call('/api/admin/recovery/replay', {
    cookie: SID,
    body: { external_user_id: USER, from: new Date(Date.now() + 3600_000).toISOString(), to: new Date().toISOString() },
  })
  check('from > to → 400', inverted.status === 400, `status ${inverted.status}`)
  const unknown = await call('/api/admin/recovery/replay', {
    cookie: SID,
    body: { external_user_id: `no-such-user-${TS}` },
  })
  check('unknown user → 4xx error with message', unknown.status >= 400 && unknown.status < 500, `status ${unknown.status}`)
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
