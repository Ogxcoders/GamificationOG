/**
 * GamificationOG — E2E Regions & Data Residency suite (§ Phase 5).
 * Covers: region registry bootstrap, project pinning + audit, strict-policy
 * rejection (events + identify), soft tag policy, global fallback, export
 * manifest region portability. Re-pins the project to global on cleanup.
 *
 * Usage: bun scripts/e2e-region.ts [baseUrl]
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
  opts: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
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
    /* ignore */
  }
  return { status: res.status, json, setCookie }
}

const cookieOf = (s: string) => s.split(';')[0]

console.log('\n════════════ GamificationOG — E2E REGIONS / RESIDENCY ════════════')
console.log(`Target: ${BASE}\n`)

let SID = ''
let KEY = ''
{
  const login = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  check('owner login works', login.status === 200)
  SID = cookieOf(login.setCookie)
  const keyRes = await call('/api/admin/apikeys/list', {
    cookie: SID,
    method: 'POST',
    body: { name: `e2e-region-${Date.now()}`, scopes: ['events:write', 'state:read'] },
  })
  KEY = keyRes.json?.key?.key ?? ''
  check('API key created', !!KEY)
}
const authHeaders = { authorization: `Bearer ${KEY}` }

// ---------- 1. Region registry ----------
console.log('\n▸ 1. Region registry')
{
  const res = await call('/api/admin/regions', { cookie: SID })
  check('regions listed', res.status === 200)
  const codes = (res.json?.regions ?? []).map((r: any) => r.code)
  check('default regions seeded (global/eu/us/apac)', ['global', 'eu', 'us', 'apac'].every((c) => codes.includes(c)))
  const eu = (res.json?.regions ?? []).find((r: any) => r.code === 'eu')
  check('eu policy is strict', eu?.policy?.enforcement === 'strict')
  const apac = (res.json?.regions ?? []).find((r: any) => r.code === 'apac')
  check('apac policy is tag', apac?.policy?.enforcement === 'tag')

  const noAuth = await call('/api/admin/regions')
  check('regions require admin session', noAuth.status === 401)
}

// ---------- 2. Pin project to EU ----------
console.log('\n▸ 2. Project region pinning')
{
  const bad = await call('/api/admin/regions?code=moon', { cookie: SID, method: 'PUT' })
  check('unknown region rejected (404)', bad.status === 404, bad.json?.error?.code)

  const pin = await call('/api/admin/regions?code=eu', { cookie: SID, method: 'PUT' })
  check('project pinned to eu', pin.status === 200 && pin.json?.dataRegion === 'eu')
  check('previous region reported', pin.json?.previous === 'global')

  const report = await call('/api/admin/regions?report=1', { cookie: SID })
  const euRegion = (report.json?.regions ?? []).find((r: any) => r.code === 'eu')
  check('report counts pinned project', (euRegion?.projectCount ?? 0) >= 1)
}

// ---------- 3. Strict enforcement ----------
console.log('\n▸ 3. Strict residency enforcement (eu-pinned project)')
{
  const evtUs = await call('/api/v1/events', {
    headers: { ...authHeaders, 'x-gog-region': 'us' },
    method: 'POST',
    body: { external_user_id: `region-user-${Date.now()}`, event_type: 'task.completed', payload: { region: 'us' } },
  })
  check('us-asserted event rejected (422)', evtUs.status === 422, `status ${evtUs.status}`)
  check('error code RESIDENCY_VIOLATION', evtUs.json?.error?.code === 'RESIDENCY_VIOLATION')
  check('error names both regions', String(evtUs.json?.error?.detail ?? '').includes('eu') && String(evtUs.json?.error?.detail ?? '').includes('us'))

  const evtEu = await call('/api/v1/events', {
    headers: { ...authHeaders, 'x-gog-region': 'eu' },
    method: 'POST',
    body: { external_user_id: `region-user-${Date.now()}`, event_type: 'task.completed', payload: {} },
  })
  check('eu-asserted event accepted', evtEu.status === 200 || evtEu.status === 202, `status ${evtEu.status}`)

  const evtNoRegion = await call('/api/v1/events', {
    headers: authHeaders,
    method: 'POST',
    body: { external_user_id: `region-user-${Date.now()}`, event_type: 'task.completed', payload: {} },
  })
  check('unasserted region defaults to allowed (global)', evtNoRegion.status === 200 || evtNoRegion.status === 202)

  const idUs = await call('/api/v1/identify', {
    headers: { ...authHeaders, 'x-gog-region': 'us' },
    method: 'POST',
    body: { external_id: `region-id-${Date.now()}`, attributes: { region: 'us' } },
  })
  check('us-asserted identify rejected', idUs.status === 422)

  const idEu = await call('/api/v1/identify', {
    headers: { ...authHeaders, 'x-gog-region': 'eu' },
    method: 'POST',
    body: { external_id: `region-id-eu-${Date.now()}` },
  })
  check('eu identify accepted', idEu.status === 200)
}

// ---------- 4. Tag (soft) policy ----------
console.log('\n▸ 4. Soft tag policy (apac)')
{
  await call('/api/admin/regions?code=apac', { cookie: SID, method: 'PUT' })
  const tagged = await call('/api/v1/events', {
    headers: { ...authHeaders, 'x-gog-region': 'us' },
    method: 'POST',
    body: { external_user_id: `region-user-${Date.now()}`, event_type: 'task.completed', payload: {} },
  })
  check('cross-region traffic allowed under tag policy', tagged.status === 200 || tagged.status === 202, `status ${tagged.status}`)
  check('response carries cross-region tag', tagged.json?.residency?.tagged === true && String(tagged.json?.residency?.tag ?? '').includes('cross-region'), tagged.json?.residency?.tag)
}

// ---------- 5. Export manifest region portability ----------
console.log('\n▸ 5. Export manifest carries data region')
{
  const res = await call('/api/admin/export', { cookie: SID })
  check('export includes dataRegion in manifest', res.json?.manifest?.dataRegion === 'apac', res.json?.manifest?.dataRegion)
}

// ---------- 6. Audit + cleanup ----------
console.log('\n▸ 6. Pin audit + restore global')
{
  const audit = await call('/api/admin/audit/list?limit=50', { cookie: SID })
  const actions = (audit.json?.entries ?? []).map((a: any) => a.action)
  check('region.project_pinned audited', actions.includes('region.project_pinned'))

  const restore = await call('/api/admin/regions?code=global', { cookie: SID, method: 'PUT' })
  check('project restored to global (cleanup)', restore.status === 200 && restore.json?.dataRegion === 'global')

  // global region: no enforcement
  const evt = await call('/api/v1/events', {
    headers: { ...authHeaders, 'x-gog-region': 'us' },
    method: 'POST',
    body: { external_user_id: `region-user-${Date.now()}`, event_type: 'task.completed', payload: {} },
  })
  check('global region accepts any traffic', evt.status === 200 || evt.status === 202)
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
