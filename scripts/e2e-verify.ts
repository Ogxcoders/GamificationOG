/**
 * GamificationOG — End-to-end verification script.
 * Runs the full platform loop against the live dev server:
 *   admin auth → API key → identify → events (engine pipeline)
 *   → state → leaderboards → flags/config → admin observability → UI.
 * Prints a PASS/FAIL table; exits non-zero on any failure.
 *
 * Usage: bun scripts/e2e-verify.ts [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://localhost:3000'

// ---------- helpers ----------
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

function info(name: string, detail = '') {
  console.log(`  ℹ️  ${name}${detail ? ` — ${detail}` : ''}`)
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
    /* non-json response */
  }
  return { status: res.status, json, setCookie }
}

const cookieOf = (setCookie: string) => setCookie.split(';')[0]

// ---------- 0. server up ----------
console.log('\n════════════ GamificationOG — END-TO-END VERIFICATION ════════════')
console.log(`Target: ${BASE}\n`)

console.log('▸ 0. Server health')
{
  const res = await fetch(`${BASE}/`)
  check('GET / (dashboard overview) responds 200', res.status === 200)
  const login = await fetch(`${BASE}/login`)
  check('GET /login responds 200', login.status === 200)
}

// ---------- 1. admin auth ----------
console.log('\n▸ 1. Admin authentication')
let SID = ''
{
  const r = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  check('login with seeded owner', r.status === 200 && r.json?.ok === true, r.json?.email ?? '')
  SID = cookieOf(r.setCookie)
  check('session cookie issued (gog_sid)', SID.startsWith('gog_sid='))

  const me = await call('/api/admin/auth/me', { cookie: SID })
  check(
    'GET /api/admin/auth/me returns owner profile',
    me.status === 200 && me.json?.authenticated === true && me.json?.admin?.email === 'owner@focusquest.app',
    `role=${me.json?.admin?.role}`,
  )

  const bad = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'wrong-password' },
  })
  check('wrong password rejected (401)', bad.status === 401, `status ${bad.status}`)

  const noauth = await call('/api/admin/analytics/summary')
  check('admin API requires session', noauth.status === 401, `status ${noauth.status}`)
}

// ---------- 2. API key ----------
console.log('\n▸ 2. API key lifecycle')
let KEY = ''
let KEY_ID = ''
{
  const r = await call('/api/admin/apikeys/list', {
    cookie: SID,
    body: { name: 'E2E verification key', scopes: ['events:write', 'state:read'] },
  })
  KEY = r.json?.key?.key ?? ''
  KEY_ID = r.json?.key?.id ?? ''
  check(
    'create API key (secret returned once)',
    r.status === 201 && typeof KEY === 'string' && KEY.startsWith('gog_'),
    `prefix ${KEY.slice(0, 12)}…`,
  )

  const list = await call('/api/admin/apikeys/list', { cookie: SID })
  check(
    'list API keys (masked, no secrets)',
    list.status === 200 &&
      Array.isArray(list.json?.keys) &&
      list.json.keys.length >= 2 &&
      list.json.keys.every((k: any) => !k.key && !k.secret),
    `${list.json?.keys?.length} keys`,
  )

  const unauth = await call('/api/v1/events', { body: { event_type: 'task.completed' } })
  check('v1 API rejects missing key', unauth.status === 401, `status ${unauth.status}`)

  const invalid = await call('/api/v1/events', {
    headers: { authorization: 'Bearer gog_totally_invalid_key' },
    body: { event_type: 'task.completed' },
  })
  check('v1 API rejects invalid key', invalid.status === 401, `status ${invalid.status}`)
}

const auth = { authorization: `Bearer ${KEY}` }

// ---------- 3. identity ----------
console.log('\n▸ 3. Identity (identify + merge)')
const USER = 'e2e_zoe_' + Date.now().toString(36).slice(-4)
{
  const r = await call('/api/v1/identify', {
    headers: auth,
    body: { external_id: USER, display_name: 'Zoe E2E', attributes: { plan: 'pro', country: 'IN' } },
  })
  check('identify new user', r.status === 200 && r.json?.created === true && !!r.json?.user_id, `user_id ${r.json?.user_id?.slice(0, 8)}…`)

  const again = await call('/api/v1/identify', {
    headers: auth,
    body: { external_id: USER },
  })
  check('re-identify is idempotent (created=false)', again.status === 200 && again.json?.created === false)

  const anon = USER + '_anon'
  await call('/api/v1/identify', { headers: auth, body: { external_id: anon, anonymous: true } })
  const merged = await call('/api/v1/identify', {
    headers: auth,
    body: { external_id: USER + '_known', merge_from_external_id: anon },
  })
  check('anonymous → known merge succeeds', merged.status === 200 && typeof merged.json?.user_id === 'string', `merged=${merged.json?.merged}`)
}

// ---------- 4. event pipeline ----------
console.log('\n▸ 4. Event gateway + rule engine (core loop)')
let xp = 0
let coins = 0
let levelUps = 0
let traceIds: string[] = []
{
  // 10 hard tasks: 50 XP + 10 coins each; level-ups along the way; booster drops at level ≥ 3
  for (let i = 1; i <= 10; i++) {
    const r = await call('/api/v1/events', {
      headers: auth,
      body: {
        event_type: 'task.completed',
        external_user_id: USER,
        payload: { difficulty: 'hard', count: 1 },
        metadata: { source: 'e2e-test' },
      },
    })
    const d = r.json?.stateDelta
    const ok = r.status === 200 && r.json?.status === 'processed'
    if (ok) {
      xp += d?.xpAwarded ?? 0
      coins += (d?.currencyChanges ?? [])
        .filter((c: any) => c.currency === 'coins')
        .reduce((s: number, c: any) => s + c.amount, 0)
      levelUps += d?.levelUps?.length ?? 0
      if (r.json?.traceId) traceIds.push(r.json.traceId)
    }
    check(
      `task.completed (hard) #${i} processed`,
      ok,
      `+${d?.xpAwarded ?? 0} XP${d?.levelUps?.length ? `, LEVEL UP ${d.levelUps.map((l: any) => `${l.from}→${l.to}`).join(',')}` : ''}`,
    )
  }

  const focus = await call('/api/v1/events', {
    headers: auth,
    body: { event_type: 'focus.session.completed', external_user_id: USER, payload: { minutes: 30 } },
  })
  const focusXp = focus.json?.stateDelta?.xpAwarded ?? 0
  xp += focusXp
  check(
    'focus.session.completed → 60 XP base (+20 night-owl bonus when 20:00–04:00 UTC)',
    focus.status === 200 && (focusXp === 60 || focusXp === 80),
    `+${focusXp} XP${focusXp === 80 ? ' (night-owl bonus fired — correct)' : ''}`,
  )

  const ref = await call('/api/v1/events', {
    headers: auth,
    body: { event_type: 'referral.sent', external_user_id: USER },
  })
  const gemDelta = (ref.json?.stateDelta?.currencyChanges ?? []).find((c: any) => c.currency === 'gems')
  check(
    'referral.sent → +1 gem + notification action',
    ref.status === 200 && gemDelta?.amount === 1,
    `notifications: ${ref.json?.stateDelta?.notifications}`,
  )

  // batch ingestion
  const batch = await call('/api/v1/events', {
    headers: auth,
    body: {
      events: [
        { event_type: 'task.completed', external_user_id: USER, payload: { difficulty: 'easy', count: 1 } },
        { event_type: 'task.completed', external_user_id: USER, payload: { difficulty: 'medium', count: 1 } },
        { event_type: 'focus.session.completed', external_user_id: USER, payload: { minutes: 15 } },
      ],
    },
  })
  xp += (batch.json?.results ?? []).reduce((s: number, r: any) => s + (r.stateDelta?.xpAwarded ?? 0), 0)
  check(
    'batch ingestion (3 events, one request)',
    batch.status === 200 && batch.json?.batch === true && batch.json?.results?.length === 3,
    `+${(batch.json?.results ?? []).reduce((s: number, r: any) => s + (r.stateDelta?.xpAwarded ?? 0), 0)} XP total`,
  )

  // idempotency
  const idemKey = `e2e-idem-${Date.now()}`
  const first = await call('/api/v1/events', {
    headers: auth,
    body: { event_type: 'task.completed', external_user_id: USER, payload: { difficulty: 'easy', count: 1 }, idempotency_key: idemKey },
  })
  const second = await call('/api/v1/events', {
    headers: auth,
    body: { event_type: 'task.completed', external_user_id: USER, payload: { difficulty: 'easy', count: 1 }, idempotency_key: idemKey },
  })
  check(
    'idempotency: replayed event deduped',
    first.json?.status === 'processed' && second.json?.status === 'duplicate',
    `1st=${first.json?.status}, 2nd=${second.json?.status}`,
  )

  // schema validation
  const invalid = await call('/api/v1/events', {
    headers: auth,
    body: { event_type: 'task.completed', external_user_id: USER, payload: { count: 999 } },
  })
  check('schema validation rejects count=999 (max 20)', invalid.status === 400, `status ${invalid.status}`)

  // unknown event types: loose-mode (no schema registered → no validation, no rules fire)
  const unknown = await call('/api/v1/events', {
    headers: auth,
    body: { event_type: 'does.not.exist', external_user_id: USER },
  })
  check(
    'unknown event type accepted in loose mode (recorded, no rules fire)',
    unknown.status === 200 && unknown.json?.status === 'processed' && (unknown.json?.actions?.length ?? 0) === 0,
    `actions=${unknown.json?.actions?.length ?? 0}`,
  )

  const noUser = await call('/api/v1/events', {
    headers: auth,
    body: { event_type: 'task.completed' },
  })
  check(
    'event without user recorded as skipped (not crashed)',
    noUser.status === 200 && noUser.json?.status === 'skipped',
    `error: ${noUser.json?.error}`,
  )
}

// ---------- 5. user state ----------
console.log('\n▸ 5. User state aggregate (progression / economy / inventory / challenges / streaks)')
{
  const r = await call(`/api/v1/users/${USER}/state`, { headers: auth })
  const s = r.json
  check('GET user state snapshot', r.status === 200 && !!s?.user, `user=${s?.user?.display_name}`)

  const prog = s?.progression?.[0]
  check('XP accumulated through events', typeof prog?.xp === 'number' && prog.xp >= 600, `xp=${prog?.xp}`)
  check('level-ups computed', typeof prog?.level === 'number' && prog.level >= 5 && levelUps >= 3, `level=${prog?.level}, ${levelUps} level-up events`)
  check('progress metadata (xpForNextLevel, %)', typeof prog?.xpForNextLevel === 'number' && typeof prog?.progressPercent === 'number', `${prog?.progressPercent}% to next`)

  const wallets = s?.wallets ?? []
  const coinsBal = wallets.find((w: any) => w.currency === 'coins')?.balance ?? 0
  const gemsBal = wallets.find((w: any) => w.currency === 'gems')?.balance ?? 0
  check('coins wallet credited (ledger-backed)', coinsBal >= 120, `coins=${coinsBal}`)
  check('gems wallet credited', gemsBal >= 1, `gems=${gemsBal}`)

  const inv = s?.inventory ?? []
  const booster = inv.find((i: any) => i.code === 'focus_booster')
  if (booster) {
    check('item drop (focus_booster granted by hard-task rule)', booster.quantity >= 1, `qty=${booster.quantity}`)
  } else {
    info('item drop is probabilistic — not granted this run (level-gated rule)')
  }

  const challenges = s?.challenges ?? []
  const daily = challenges.find((c: any) => c.type === 'daily')
  check(
    'daily challenge auto-tracked + completed',
    challenges.length > 0 && !!daily && daily.completed === true,
    `"${daily?.name}" ${daily?.progress}/${daily?.target}`,
  )

  const streaks = s?.streaks ?? []
  check('streak engine tracking (current/best)', streaks.length > 0 && (streaks[0]?.current ?? 0) >= 1, `current=${streaks[0]?.current}, best=${streaks[0]?.best}`)

  const achievements = s?.achievements ?? []
  const unlocked = achievements.filter((a: any) => a.unlocked)
  check('achievements unlocked via events', unlocked.length >= 1, `${unlocked.length}/${achievements.length} unlocked: ${unlocked.map((a: any) => a.code).join(', ')}`)
}

// ---------- 6. leaderboards + flags ----------
console.log('\n▸ 6. Leaderboards, flags, experiments, remote config, segments')
{
  const lb = await call(`/api/v1/leaderboards?code=daily_tasks&user=${USER}&limit=10`, { headers: auth })
  const entries = lb.json?.entries ?? []
  const around = lb.json?.around
  check(
    'daily_tasks leaderboard ranked',
    lb.status === 200 && entries.length > 0 && typeof entries[0]?.rank === 'number' && !!entries[0]?.score,
    `rank #${around?.rank} score=${around?.score} (top: ${entries[0]?.user})`,
  )

  const xpLb = await call(`/api/v1/leaderboards?code=all_time_xp&limit=5`, { headers: auth })
  check(
    'all_time_xp leaderboard returned',
    xpLb.status === 200 && (xpLb.json?.entries?.length ?? 0) > 0,
    `${xpLb.json?.entries?.length} entries, #1 ${xpLb.json?.entries?.[0]?.user} (${xpLb.json?.entries?.[0]?.score})`,
  )

  const flags = await call(`/api/v1/flags?user=${USER}`, { headers: auth })
  const f = flags.json
  check(
    'flags + experiments + config + segments evaluation',
    flags.status === 200 &&
      !!f?.flags &&
      Object.keys(f.flags).length >= 2 &&
      !!f?.experiments &&
      !!f?.config?.daily_xp_cap,
    `flags={${Object.entries(f?.flags ?? {}).map(([k, v]) => `${k}:${v}`).join(', ')}}, exp variant=${JSON.stringify(f?.experiments)}, segments=[${f?.segments}]`,
  )
}

// ---------- 7. admin observability ----------
console.log('\n▸ 7. Admin observability (feed / traces / analytics / audit / users)')
{
  const feed = await call('/api/admin/events/feed?limit=30', { cookie: SID })
  const feedEvents = feed.json?.events ?? []
  check(
    'events feed lists ingested events (with type counts)',
    feed.status === 200 && feedEvents.length > 0 && !!feedEvents[0]?.type && (feed.json?.typeCounts?.length ?? 0) > 0,
    `${feedEvents.length} events, latest=${feedEvents[0]?.type}, types: ${(feed.json?.typeCounts ?? []).slice(0, 3).map((t: any) => `${t.type}×${t.count}`).join(', ')}`,
  )

  const traces = await call('/api/admin/traces/list?limit=200', { cookie: SID })
  const traceList = traces.json?.traces ?? []
  check(
    'decision traces recorded (full pipeline audit)',
    traceList.length > 0 && !!traceList[0]?.id && typeof traceList[0]?.actionsCount === 'number',
    `${traceList.length} traces, top: ${traceList[0]?.summary}`,
  )

  if (traceIds.length > 0) {
    const allTraceIds = new Set(traceList.map((t: any) => t.id))
    const foundTrace = traceIds.every((id) => allTraceIds.has(id))
    check(
      'ingestion traceId === trace store id (SDK trace lookup resolves)',
      foundTrace,
      `${traceIds.filter((id) => allTraceIds.has(id)).length}/${traceIds.length} ingestion trace ids found in store`,
    )

    // deep-dive one trace: steps must exist and be expandable
    const detail = await call(`/api/admin/traces/list?id=${traceIds[traceIds.length - 1]}`, { cookie: SID })
    const steps = detail.json?.trace?.steps ?? []
    check(
      'trace detail returns full pipeline steps',
      detail.status === 200 && steps.length >= 3,
      `${steps.length} steps: ${steps.slice(0, 4).map((s: any) => s.name ?? s.stage ?? s.title).filter(Boolean).join(' → ')}`,
    )
  }

  const analytics = await call('/api/admin/analytics/summary', { cookie: SID })
  const totals = analytics.json?.summary?.totals
  check(
    'analytics summary aggregates metrics',
    analytics.status === 200 && (totals?.events_ingested ?? 0) > 0 && (totals?.actions_executed ?? 0) > 0,
    `events=${totals?.events_ingested}, processed=${totals?.events_processed}, actions=${totals?.actions_executed}, active_users=${totals?.active_users}`,
  )

  const audit = await call('/api/admin/audit/list?limit=20', { cookie: SID })
  const auditList = audit.json?.entries ?? audit.json?.audit ?? []
  const hasKeyAudit = auditList.some((a: any) => String(a.action ?? '').includes('api_key'))
  check(
    'audit log records api_key.created',
    audit.status === 200 && hasKeyAudit,
    `${auditList.length} entries`,
  )

  const users = await call('/api/admin/users/list?limit=10', { cookie: SID })
  check(
    'admin users explorer API',
    users.status === 200 && (users.json?.users?.length ?? 0) > 0,
    `${users.json?.users?.length} users listed`,
  )

  // generic CRUD via [resource]
  const rules = await call('/api/admin/rules?limit=5', { cookie: SID })
  check('generic admin CRUD (rules resource)', rules.status === 200, `${Array.isArray(rules.json?.items ?? rules.json?.rules) ? (rules.json?.items ?? rules.json?.rules).length : '?'} rules`)
}

// ---------- 8. dashboard UI ----------
console.log('\n▸ 8. Dashboard pages render (all 19 routes)')
{
  const pages = [
    '/', '/events', '/rules', '/challenges', '/achievements', '/streaks', '/rewards',
    '/economy', '/inventory', '/leaderboards', '/segments', '/experiments', '/analytics',
    '/users', '/traces', '/audit', '/playground', '/settings', '/registry',
  ]
  let okCount = 0
  for (const p of pages) {
    const r = await fetch(`${BASE}${p}`, { headers: { cookie: SID }, redirect: 'manual' })
    const ok = r.status === 200
    if (ok) okCount++
    check(`page ${p === '/' ? '/ (overview)' : p} renders`, ok, `status ${r.status}`)
  }
  check('ALL dashboard pages render', okCount === pages.length, `${okCount}/${pages.length}`)
}

// ---------- 9. cleanup ----------
{
  if (KEY_ID) {
    const r = await call(`/api/admin/apikeys/list?id=${KEY_ID}`, { cookie: SID, method: 'DELETE' })
    info(`revoked E2E API key (${r.json?.revoked === true ? 'ok' : `status ${r.status}`})`)
  }
}

// ---------- summary ----------
console.log('\n════════════════════════════════════════════════════════════════')
console.log(`  RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(`  Failed: ${failures.join(' | ')}`)
  process.exit(1)
} else {
  console.log('  🎉 ALL END-TO-END CHECKS PASSED — platform fully operational.')
  process.exit(0)
}
