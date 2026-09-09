/**
 * Prod-boot smoke: login → API key → ingest event → read user state,
 * executed against the standalone production server (PORT=3100).
 */
const BASE = process.argv[2] ?? 'http://localhost:3100'
let pass = 0, fail = 0
const ok = (m: string, c: boolean, extra = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${m}${extra ? ' — ' + extra : ''}`)
  c ? pass++ : fail++
}

async function main() {
  console.log(`▸ Prod boot smoke @ ${BASE}`)
  // 1. admin login
  const login = await fetch(`${BASE}/api/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@focusquest.app', password: 'gamification123' }),
  })
  const sid = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('gog_sid=')) ?? ''
  ok('admin login (owner)', login.status === 200 && sid !== '')

  // 2. create API key
  const kr = await fetch(`${BASE}/api/admin/apikeys/list`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: sid },
    body: JSON.stringify({ name: 'prod boot smoke key', scopes: ['events:write', 'state:read'] }),
  })
  const keyBody = await kr.json().catch(() => ({}))
  const key = keyBody?.key?.key ?? ''
  ok('API key created', kr.status === 201 && key.startsWith('gog_'), key.slice(0, 10) + '…')

  // 3. ingest event
  // 3. identify user (progressive identity — required before processing events)
  const extId = `prod-boot-${Date.now()}`
  const idn = await fetch(`${BASE}/api/v1/identify`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ external_id: extId, display_name: 'Prod Boot Smoke' }),
  })
  ok('user identified (v1/identify)', idn.status === 200 || idn.status === 201, `status ${idn.status}`)

  const ev = await fetch(`${BASE}/api/v1/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ event_type: 'task.completed', external_user_id: extId, payload: { difficulty: 'hard', minutes: 25 } }),
  })
  const evj = await ev.json().catch(() => ({}))
  ok('event ingested (v1, Bearer key)', ev.status === 200 || ev.status === 201, `status ${ev.status} ${evj?.status ?? evj?.error?.code ?? ''}`)
  if (ev.status === 200 && evj?.status && evj.status !== 'processed') console.log('    ⚠️ event body:', JSON.stringify(evj).slice(0, 500))

  // 4. read user state
  const st = await fetch(`${BASE}/api/v1/users/${extId}/state`, {
    headers: { authorization: `Bearer ${key}` },
  })
  const stj = await st.json().catch(() => ({}))
  ok('user state readable', st.status === 200, `xp=${stj?.state?.xp ?? stj?.xp ?? stj?.points ?? 'n/a'}`)
  if (st.status !== 200) console.log('    ⚠️ state body:', JSON.stringify(stj).slice(0, 400))

  // 5. cleanup: revoke key + remove smoke user
  await fetch(`${BASE}/api/admin/apikeys/list?id=${keyBody?.key?.id ?? ''}`, {
    method: 'DELETE', headers: { cookie: sid },
  })
  console.log(`\n──────────── RESULT ────────────\n  pass: ${pass}  fail: ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
