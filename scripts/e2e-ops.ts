/**
 * GamificationOG — E2E OPS suite (§ Advanced observability).
 * Covers: health probe shape/status, cache headers, metrics auth,
 * Prometheus text format, metric correctness after live traffic.
 *
 * Usage: bun scripts/e2e-ops.ts [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://localhost:3000'

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

console.log('\n════════════ GamificationOG — E2E OPS (OBSERVABILITY) ════════════')
console.log(`Target: ${BASE}\n`)

// ---------- 1. Health probe ----------
console.log('▸ 1. Health probe (public, no auth)')
{
  const res = await call('/api/health')
  check('GET /api/health responds 200', res.status === 200)
  const h = res.json
  check('status = ok', h?.status === 'ok')
  check('database check ok', h?.checks?.database?.ok === true, `latency ${h?.checks?.database?.latencyMs}ms`)
  check('engine check ok', h?.checks?.engine?.ok === true, `${h?.checks?.engine?.actionRegistrySize} actions / ${h?.checks?.engine?.conditionOperators} operators`)
  check('uptimeSeconds reported', typeof h?.uptimeSeconds === 'number' && h.uptimeSeconds >= 0)
  check('version reported', typeof h?.version === 'string')
  check('timestamp ISO', typeof h?.timestamp === 'string' && h.timestamp.includes('T'))
  check('cache-control: no-store', (res.headers.get('cache-control') ?? '').includes('no-store'))
}

// ---------- 2. Metrics auth ----------
console.log('\n▸ 2. Metrics endpoint auth')
let SID = ''
{
  const noAuth = await call('/api/metrics', { raw: true })
  check('GET /api/metrics without auth → 401', noAuth.status === 401, `status ${noAuth.status}`)
  const login = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  check('owner login works', login.status === 200)
  SID = cookieOf(login.setCookie)
}

// ---------- 3. Prometheus exposition format ----------
console.log('\n▸ 3. Prometheus text format')
let baseline = 0
{
  const res = await call('/api/metrics', { cookie: SID, raw: true })
  check('GET /api/metrics with admin session → 200', res.status === 200)
  check('content-type is prometheus text', (res.headers.get('content-type') ?? '').includes('text/plain'))
  const text = res.text
  check('contains # HELP lines', text.includes('# HELP gog_events_total'))
  check('contains # TYPE declarations', text.includes('# TYPE gog_events_total counter'))
  check('contains gog_process_uptime_seconds', text.includes('gog_process_uptime_seconds'))
  check('contains gog_process_resident_memory_bytes', text.includes('gog_process_resident_memory_bytes'))
  check('contains domain metrics (rules/users/traces)', text.includes('gog_rules_total') && text.includes('gog_users_total') && text.includes('gog_decision_traces_total'))
  check('contains gog_admin_sessions_active', text.includes('gog_admin_sessions_active'))
  check('contains gog_login_failures_total', text.includes('gog_login_failures_total'))
  const m = text.match(/^gog_events_total (\d+)$/m)
  check('gog_events_total has numeric sample', !!m, m ? m[1] : 'missing')
  baseline = m ? Number(m[1]) : -1
  const sess = text.match(/^gog_admin_sessions_active (\d+)$/m)
  check('active sessions >= 1 (we are logged in)', !!sess && Number(sess[1]) >= 1, sess ? sess[1] : 'missing')
}

// ---------- 4. Metrics react to live traffic ----------
console.log('\n▸ 4. Metrics track live traffic')
{
  // create a scoped key and ingest one event through the public pipeline
  const created = await call('/api/admin/apikeys/list', {
    cookie: SID,
    method: 'POST',
    body: { name: `e2e-ops-${Date.now()}`, scopes: ['events:write', 'state:read'] },
  })
  const apiKey: string | undefined = created.json?.key?.key
  check('API key created (secret returned once)', created.status === 201 && !!apiKey)
  if (apiKey) {
    const evt = await call('/api/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        external_user_id: `ops-user-${Date.now()}`,
        event_type: 'task.completed',
        payload: { title: 'ops probe' },
      },
    })
    check('event ingested (202/200)', evt.status === 200 || evt.status === 202, `status ${evt.status}`)
    const res2 = await call('/api/metrics', { cookie: SID, raw: true })
    const m2 = res2.text.match(/^gog_events_total (\d+)$/m)
    const after = m2 ? Number(m2[1]) : -1
    check('gog_events_total increased after ingestion', after > baseline, `${baseline} -> ${after}`)
    // cleanup: revoke the probe key
    await call('/api/admin/apikeys/list?id=' + created.json?.key?.id, { cookie: SID, method: 'DELETE' })
  }
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
