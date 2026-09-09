/**
 * GamificationOG — E2E RISK ENGINE suite (§74 Fraud / Abuse / Anti-Cheat).
 * Covers: default-off fail-open, velocity + duplicate detection (hold/reject),
 * admin flag review + release (side effects fire once) + reject,
 * impossible-speed throttling, value-anomaly detection, multi-account signal,
 * disable → fail-open. Leaves the risk config DISABLED on exit so other
 * suites are unaffected.
 *
 * Usage: bun scripts/e2e-fraud.ts [baseUrl]
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

console.log('\n════════════ GamificationOG — E2E RISK ENGINE (§74) ════════════')
console.log(`Target: ${BASE}\n`)

// ---------- 0. Login + API key ----------
let SID = ''
let APIKEY = ''
{
  const login = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  check('owner login works', login.status === 200)
  SID = cookieOf(login.setCookie)

  const created = await call('/api/admin/apikeys/list', {
    cookie: SID,
    method: 'POST',
    body: { name: `e2e-fraud-${TS}`, scopes: ['events:write', 'events:read'] },
  })
  APIKEY = created.json?.key?.key ?? ''
  check('API key created', created.status === 201 && !!APIKEY)
}

async function sendEvent(user: string, type: string, payload: Record<string, unknown>, subjectId?: string) {
  return call('/api/v1/events', {
    method: 'POST',
    headers: { authorization: `Bearer ${APIKEY}` },
    body: {
      external_user_id: user,
      event_type: type,
      payload,
      ...(subjectId ? { subject_id: subjectId } : {}),
    },
  })
}

const identified = new Set<string>()
async function ensureUser(user: string) {
  if (identified.has(user)) return
  const r = await call('/api/v1/identify', {
    method: 'POST',
    headers: { authorization: `Bearer ${APIKEY}` },
    body: { external_id: user, display_name: user },
  })
  if (r.status !== 200 && r.status !== 201) throw new Error(`identify failed for ${user}: ${r.status}`)
  identified.add(user)
}

// ---------- 1. Default off = fail-open ----------
console.log('\n▸ 1. Risk engine default OFF (fail-open, no config row)')
{
  const cfg = await call('/api/admin/risk', { cookie: SID })
  check('GET /api/admin/risk responds 200', cfg.status === 200)
  check('configActive = false without a config row', cfg.json?.configActive === false)
  check('counts.total reported', typeof cfg.json?.counts?.total === 'number')

  const u = `fraud-baseline-${TS}`
  await ensureUser(u)
  for (let i = 0; i < 3; i++) {
    const r = await sendEvent(u, 'fraud.baseline.v1', { i })
    check(`baseline event #${i + 1} processed (no risk gate)`, r.status === 200 && r.json?.status === 'processed')
  }
  const cfg2 = await call('/api/admin/risk?status=open', { cookie: SID })
  const baselineFlags = (cfg2.json?.flags ?? []).filter((f: any) => f.eventType === 'fraud.baseline.v1')
  check('no flags raised for baseline traffic', baselineFlags.length === 0)
}

// ---------- 2. Velocity + duplicate → hold / reject ----------
console.log('\n▸ 2. Velocity + duplicate burst → hold then reject')
{
  const on = await call('/api/admin/risk', {
    cookie: SID,
    body: {
      enabled: true,
      maxEventsPerMinute: 3,
      maxEventsPerHour: 10000,
      maxDuplicatePayloads: 2,
      duplicateWindowMinutes: 10,
      minEventIntervalMs: 0,
      maxValueStddevs: 99,
      thresholdThrottle: 40,
      thresholdHold: 60,
      thresholdReject: 80,
    },
  })
  check('risk config enabled with tight thresholds', on.status === 200 && on.json?.config?.enabled === true)

  const u = `fraud-burst-${TS}`
  await ensureUser(u)
  const statuses: string[] = []
  const risks: Array<{ decision: string; score: number; reasons: Array<{ code: string }> }> = []
  const eventIds: string[] = []
  for (let i = 0; i < 8; i++) {
    const r = await sendEvent(u, 'fraud.burst.v1', { claim: 'identical-reward-farm' })
    statuses.push(r.json?.status ?? `http_${r.status}`)
    if (r.json?.risk) risks.push(r.json.risk)
    if (r.json?.eventId) eventIds.push(r.json.eventId)
  }
  const expected = ['processed', 'processed', 'processed', 'held', 'held', 'rejected', 'rejected', 'rejected']
  check(
    'burst statuses follow allow→hold→reject ladder',
    JSON.stringify(statuses) === JSON.stringify(expected),
    statuses.join(',')
  )
  check('held/rejected responses carry risk info', risks.length === 5 && risks.every((r) => r.decision === 'hold' || r.decision === 'reject'))

  const holdList = await call('/api/admin/risk?status=open&decision=hold&limit=200', { cookie: SID })
  const holdFlag = (holdList.json?.flags ?? []).find((f: any) => f.eventType === 'fraud.burst.v1' && eventIds.includes(f.eventId))
  const holdCodes = (holdFlag?.reasons ?? []).map((r: any) => r.code)
  check(
    'risk reasons include VELOCITY + DUPLICATE codes',
    holdCodes.includes('VELOCITY_MINUTE') && holdCodes.includes('DUPLICATE_PAYLOAD'),
    holdCodes.join(','),
  )

  const openCounts = await call('/api/admin/risk?status=open&limit=200', { cookie: SID })
  const burstOpen = (openCounts.json?.flags ?? []).filter((f: any) => f.eventType === 'fraud.burst.v1' && eventIds.includes(f.eventId))
  check('open flags recorded for held+rejected events', burstOpen.length === 5, `${burstOpen.length} open flags`)
  const heldFlag = burstOpen.find((f: any) => f.decision === 'hold')
  const rejectedFlag = burstOpen.find((f: any) => f.decision === 'reject')
  check('held flag present with score', !!heldFlag && heldFlag.score >= 60, heldFlag ? `score ${heldFlag.score}` : 'missing')
  check('rejected flag present with score >= 80', !!rejectedFlag && rejectedFlag.score >= 80, rejectedFlag ? `score ${rejectedFlag.score}` : 'missing')

  // stash for section 3
  ;(globalThis as any).__heldFlag = heldFlag
  ;(globalThis as any).__heldFlag2 = burstOpen.filter((f: any) => f.decision === 'hold')[1] ?? heldFlag
  ;(globalThis as any).__runEventIds = eventIds
}

// ---------- 3. Adjudication: release fires side effects once, reject never ----------
console.log('\n▸ 3. Admin adjudication — release / reject')
{
  const heldFlag = (globalThis as any).__heldFlag as any
  const heldFlag2 = (globalThis as any).__heldFlag2 as any
  check('two held flags available to adjudicate', !!heldFlag && !!heldFlag2)

  if (heldFlag) {
    const rel = await call(`/api/admin/risk/${heldFlag.id}/resolve`, {
      cookie: SID,
      body: { action: 'release' },
    })
    check('release responds 200', rel.status === 200)
    check('released event processed', rel.json?.result?.status === 'processed', JSON.stringify(rel.json?.result ?? {}))
    check('release produced a trace id', typeof rel.json?.result?.traceId === 'string')
    check('flag status now released', rel.json?.action === 'release')

    // double resolve → 409
    const again = await call(`/api/admin/risk/${heldFlag.id}/resolve`, {
      cookie: SID,
      body: { action: 'release' },
    })
    check('re-resolving a closed flag → 409', again.status === 409, `status ${again.status}`)
  }

  if (heldFlag2) {
    const rej = await call(`/api/admin/risk/${heldFlag2.id}/resolve`, {
      cookie: SID,
      body: { action: 'reject' },
    })
    check('reject responds 200', rej.status === 200)
    check('rejected flag closed', rej.json?.action === 'reject')

    // the underlying event must now be status=rejected
    const feed = await call('/api/v1/events?type=fraud.burst.v1&limit=200', {
      headers: { authorization: `Bearer ${APIKEY}` },
    })
    const ev = (feed.json?.events ?? []).find((e: any) => e.id === heldFlag2.eventRowId)
    check('underlying event stays rejected after admin reject', ev?.status === 'rejected', `status ${ev?.status}`)
  }

  const invalid = await call(`/api/admin/risk/does-not-exist/resolve`, {
    cookie: SID,
    body: { action: 'release' },
  })
  check('unknown flag → 404', invalid.status === 404, `status ${invalid.status}`)
}

// ---------- 4. Impossible speed → throttle (processed + flagged) ----------
console.log('\n▸ 4. Impossible speed detection → throttle')
{
  await call('/api/admin/risk', {
    cookie: SID,
    body: {
      enabled: true,
      maxEventsPerMinute: 10000,
      maxDuplicatePayloads: 10000,
      minEventIntervalMs: 60000, // anything within 60s of the last event = machine speed
      maxValueStddevs: 99,
      thresholdThrottle: 20,
      thresholdHold: 90,
      thresholdReject: 95,
    },
  })
  const u = `fraud-speed-${TS}`
  await ensureUser(u)
  const first = await sendEvent(u, `fraud.speed.${TS}.v1`, { i: 1 })
  check('first event processed normally', first.json?.status === 'processed')
  const second = await sendEvent(u, `fraud.speed.${TS}.v1`, { i: 2 })
  check('second event still processed (throttled, not blocked)', second.json?.status === 'processed')
  check('throttle surfaces risk info to caller', second.json?.risk?.decision === 'throttle', JSON.stringify(second.json?.risk ?? null))
  check('risk reason is IMPOSSIBLE_SPEED', (second.json?.risk?.reasons ?? []).some((r: any) => r.code === 'IMPOSSIBLE_SPEED'))

  const flags = await call('/api/admin/risk?status=open&decision=throttle&limit=50', { cookie: SID })
  const speedFlag = (flags.json?.flags ?? []).find((f: any) => f.eventType === `fraud.speed.${TS}.v1`)
  check('throttle flag recorded for review', !!speedFlag)

  // dismiss the throttle flag (no event impact)
  if (speedFlag) {
    const dis = await call(`/api/admin/risk/${speedFlag.id}/resolve`, {
      cookie: SID,
      body: { action: 'dismiss' },
    })
    check('dismiss closes a throttle flag', dis.status === 200)
  }
}

// ---------- 5. Value anomaly (leaderboard manipulation) ----------
console.log('\n▸ 5. Value anomaly detection')
{
  await call('/api/admin/risk', {
    cookie: SID,
    body: {
      enabled: true,
      maxEventsPerMinute: 10000,
      maxDuplicatePayloads: 10000,
      minEventIntervalMs: 0,
      maxValueStddevs: 4,
      thresholdThrottle: 25,
      thresholdHold: 90,
      thresholdReject: 95,
    },
  })
  const u = `fraud-anomaly-${TS}`
  await ensureUser(u)
  // build a population baseline: points cycles 100..108
  for (let i = 0; i < 12; i++) {
    await sendEvent(u, `fraud.anomaly.${TS}.v1`, { points: 100 + (i % 5) * 2, i })
  }
  const outlier = await sendEvent(u, `fraud.anomaly.${TS}.v1`, { points: 100000, i: 99 })
  check('outlier event throttled (processed + flagged)', outlier.json?.status === 'processed')
  check(
    'VALUE_ANOMALY reason surfaced',
    (outlier.json?.risk?.reasons ?? []).some((r: any) => r.code === 'VALUE_ANOMALY'),
    JSON.stringify(outlier.json?.risk ?? null),
  )
}

// ---------- 6. Multi-accounting (shared subject) ----------
console.log('\n▸ 6. Multi-account signal (shared subject_id)')
{
  await call('/api/admin/risk', {
    cookie: SID,
    body: {
      enabled: true,
      maxEventsPerMinute: 10000,
      maxDuplicatePayloads: 10000,
      minEventIntervalMs: 0,
      maxValueStddevs: 99,
      thresholdThrottle: 25,
      thresholdHold: 90,
      thresholdReject: 95,
    },
  })
  const subject = `device-shared-${TS}`
  const userA = `fraud-ma-a-${TS}`
  const userB = `fraud-ma-b-${TS}`
  await ensureUser(userA)
  await ensureUser(userB)
  const a = await sendEvent(userA, 'fraud.ma.v1', { n: 1 }, subject)
  check('first account on subject processed cleanly', a.json?.status === 'processed' && !a.json?.risk)
  const b = await sendEvent(userB, 'fraud.ma.v1', { n: 2 }, subject)
  check('second account on same subject throttled', b.json?.status === 'processed' && b.json?.risk?.decision === 'throttle')
  check(
    'MULTI_ACCOUNT reason surfaced',
    (b.json?.risk?.reasons ?? []).some((r: any) => r.code === 'MULTI_ACCOUNT'),
    JSON.stringify(b.json?.risk ?? null),
  )
}

// ---------- 7. Disable → fail-open ----------
console.log('\n▸ 7. Disabled engine = plain pass-through')
{
  const off = await call('/api/admin/risk', { cookie: SID, body: { enabled: false } })
  check('config disabled', off.status === 200 && off.json?.config?.enabled === false)

  const u = `fraud-open-${TS}`
  await ensureUser(u)
  const statuses: string[] = []
  for (let i = 0; i < 6; i++) {
    const r = await sendEvent(u, 'fraud.open.v1', { identical: 'payload' })
    statuses.push(r.json?.status ?? `http_${r.status}`)
  }
  check('identical rapid burst fully processed when disabled', statuses.every((s) => s === 'processed'), statuses.join(','))

  const flags = await call('/api/admin/risk?status=open&limit=200', { cookie: SID })
  const openFraud = (flags.json?.flags ?? []).filter((f: any) => f.eventType === 'fraud.open.v1')
  check('no new flags while disabled', openFraud.length === 0)
}

// ---------- 8. Audit trail ----------
console.log('\n▸ 8. Audit trail for risk actions')
{
  const audit = await call('/api/admin/audit/list?action=risk.&limit=100', { cookie: SID })
  const entries = audit.json?.entries ?? audit.json?.logs ?? []
  const riskEntries = entries.filter((e: any) => String(e.action ?? '').startsWith('risk.'))
  check('risk.config.update audited', riskEntries.some((e: any) => e.action === 'risk.config.update'))
  check('risk.flag.release audited', riskEntries.some((e: any) => e.action === 'risk.flag.release'))
  check('risk.flag.reject audited', riskEntries.some((e: any) => e.action === 'risk.flag.reject'))
}

// ---------- 9. Risk metrics exposed (§92 observability) ----------
console.log('\n▸ 9. Risk metrics on /api/metrics')
{
  const res = await call('/api/metrics', { cookie: SID, raw: true })
  check('GET /api/metrics works', res.status === 200)
  check('gog_risk_flags_total present', res.text.includes('gog_risk_flags_total'))
  check('gog_risk_flags_open present', res.text.includes('gog_risk_flags_open'))
  check('gog_events_held present', res.text.includes('gog_events_held'))
  const m = res.text.match(/^gog_risk_flags_total (\d+)$/m)
  check('risk flags counter is numeric and > 0 after this run', !!m && Number(m[1]) > 0, m ? m[1] : 'missing')
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
