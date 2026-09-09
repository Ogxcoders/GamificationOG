/**
 * GamificationOG — E2E SSO suite (§ Phase 5).
 * Exercises the complete OIDC authorization-code + PKCE round trip against
 * the built-in mock IdP: connection CRUD, login-page surface, authorize
 * redirect, code exchange, userinfo, JIT provisioning, session issue,
 * replay protection, disable semantics, audit trail.
 *
 * Usage: bun scripts/e2e-sso.ts [baseUrl]
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
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string; redirect?: RequestRedirect } = {},
) {
  const headers: Record<string, string> = { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) }
  if (opts.cookie) headers.cookie = opts.cookie
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: opts.redirect ?? 'manual',
  })
  const setCookie = res.headers.get('set-cookie') ?? ''
  let json: any = null
  let text = ''
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('json')) {
    try {
      json = await res.json()
    } catch {
      /* ignore */
    }
  } else {
    text = await res.text().catch(() => '')
  }
  return { status: res.status, json, text, setCookie, headers: res.headers, location: res.headers.get('location') ?? '' }
}

const cookieOf = (s: string) => s.split(';')[0]

console.log('\n════════════ GamificationOG — E2E SSO (OIDC) ════════════')
console.log(`Target: ${BASE}\n`)

let SID = ''
{
  const login = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
    redirect: 'follow',
  })
  check('owner login works', login.status === 200)
  SID = cookieOf(login.setCookie)
}

// ---------- 1. Mock IdP discovery ----------
console.log('\n▸ 1. Mock IdP discovery document')
{
  const res = await call('/api/mock-idp/.well-known/openid-configuration')
  check('discovery responds 200', res.status === 200)
  const doc = res.json
  check('authorization_endpoint present', typeof doc?.authorization_endpoint === 'string')
  check('token_endpoint present', typeof doc?.token_endpoint === 'string')
  check('userinfo_endpoint present', typeof doc?.userinfo_endpoint === 'string')
  check('PKCE S256 advertised', Array.isArray(doc?.code_challenge_methods_supported) && doc.code_challenge_methods_supported.includes('S256'))
}

// ---------- 2. Connection CRUD ----------
console.log('\n▸ 2. SSO connection management (admin)')
let CONN_ID = ''
{
  const bad = await call('/api/admin/sso/connections', {
    cookie: SID,
    body: { name: 'bad', issuer: 'not-a-url', clientId: 'x', clientSecret: 'y' },
  })
  check('invalid issuer rejected (400)', bad.status === 400, bad.json?.error?.code ?? '')

  const created = await call('/api/admin/sso/connections', {
    cookie: SID,
    body: {
      name: 'Mock IdP (test)',
      issuer: `${BASE}/api/mock-idp`,
      clientId: 'gog-e2e-client',
      clientSecret: 'mock-idp-client-secret',
      domains: ['example.com'],
      jitRole: 'editor',
      jitEnabled: true,
    },
  })
  check('connection created (201)', created.status === 201)
  check('creation validates discovery', created.json?.discovery?.ok === true && typeof created.json?.discovery?.token_endpoint === 'string')
  CONN_ID = created.json?.connection?.id ?? ''

  const list = await call('/api/admin/sso/connections', { cookie: SID })
  const row = (list.json?.connections ?? []).find((c: any) => c.id === CONN_ID)
  check('connection listed with masked secret', row?.clientSecretMasked?.includes('•'))
  check('masked list leaks no secret material', !JSON.stringify(list.json).includes('mock-idp-client-secret'))

  const noAuth = await call('/api/admin/sso/connections')
  check('admin list requires session (401)', noAuth.status === 401)

  const pub = await call('/api/auth/sso/connections')
  const pubRow = (pub.json?.connections ?? []).find((c: any) => c.id === CONN_ID)
  check('public list exposes id+name only', !!pubRow && pubRow.name === 'Mock IdP (test)' && Object.keys(pubRow).length === 2)
}

// ---------- 3. Full authorize → callback round trip ----------
console.log('\n▸ 3. OIDC authorization-code + PKCE round trip')
let ssoSid = ''
{
  const authRes = await call(`/api/auth/sso/authorize?connection=${CONN_ID}`)
  check('authorize redirects to IdP (302)', authRes.status === 302 || authRes.status === 307)
  const authUrl = new URL(authRes.location)
  check('IdP URL is the authorize endpoint', authUrl.pathname === '/api/mock-idp/authorize')
  check('response_type=code', authUrl.searchParams.get('response_type') === 'code')
  check('client_id forwarded', authUrl.searchParams.get('client_id') === 'gog-e2e-client')
  check('state present', !!authUrl.searchParams.get('state'))
  check('nonce present', !!authUrl.searchParams.get('nonce'))
  check('PKCE challenge + S256', !!authUrl.searchParams.get('code_challenge') && authUrl.searchParams.get('code_challenge_method') === 'S256')
  const redirectUri = authUrl.searchParams.get('redirect_uri') ?? ''
  check('redirect_uri points at callback', redirectUri.includes('/api/auth/sso/callback'))

  // --- the "user" authenticates at the IdP (JSON test mode) ---
  const idpLogin = await call('/api/mock-idp/authorize', {
    method: 'POST',
    body: {
      username: 'ada@example.com',
      password: 'mock-idp-secret',
      client_id: authUrl.searchParams.get('client_id'),
      redirect_uri: redirectUri,
      state: authUrl.searchParams.get('state'),
      code_challenge: authUrl.searchParams.get('code_challenge'),
    },
    redirect: 'manual',
  })
  check('IdP login issues redirect back (302)', idpLogin.status === 302)
  const back = new URL(idpLogin.location)
  const code = back.searchParams.get('code') ?? ''
  const state = back.searchParams.get('state') ?? ''
  check('authorization code issued', !!code)
  check('state echoed back', state === authUrl.searchParams.get('state'))

  // --- wrong state is rejected (CSRF protection) ---
  const wrongState = await call(`/api/auth/sso/callback?connection=${CONN_ID}&code=${code}&state=tampered-state`)
  check('callback with tampered state rejected', wrongState.status === 302 && (wrongState.location ?? '').includes('sso_state_invalid'), wrongState.location)

  // --- the real callback ---
  const cb = await call(`/api/auth/sso/callback?connection=${CONN_ID}&code=${code}&state=${state}`)
  const cbTarget = cb.location ? new URL(cb.location) : null
  check(
    'callback succeeds (302 to /)',
    cb.status === 302 && !!cbTarget && cbTarget.pathname === '/' && cbTarget.origin === new URL(BASE).origin,
    cb.location,
  )
  const sidCookie = cb.setCookie
  check('dashboard session cookie set', /gog_sid=/.test(sidCookie))
  check('session cookie HttpOnly', /httponly/i.test(sidCookie))
  ssoSid = cookieOf(sidCookie)

  // --- replaying the same code+state fails (single-use) ---
  const replay = await call(`/api/auth/sso/callback?connection=${CONN_ID}&code=${code}&state=${state}`)
  check('code/state replay rejected', replay.status === 302 && (replay.location ?? '').includes('sso_state_invalid'))
}

// ---------- 4. JIT-provisioned session works ----------
console.log('\n▸ 4. JIT provisioning + session validity')
{
  const me = await call('/api/admin/auth/me', { cookie: ssoSid, redirect: 'follow' })
  check('SSO session authenticates (/me 200)', me.status === 200 && me.json?.authenticated === true)
  check('JIT user email matches IdP', me.json?.admin?.email === 'ada@example.com')
  check('JIT role from connection policy', me.json?.admin?.role === 'editor', me.json?.admin?.role)

  // second login: same identity, no duplicate account
  const authRes2 = await call(`/api/auth/sso/authorize?connection=${CONN_ID}`)
  const authUrl2 = new URL(authRes2.location)
  const idpLogin2 = await call('/api/mock-idp/authorize', {
    method: 'POST',
    body: {
      username: 'ada@example.com',
      password: 'mock-idp-secret',
      client_id: authUrl2.searchParams.get('client_id'),
      redirect_uri: authUrl2.searchParams.get('redirect_uri'),
      state: authUrl2.searchParams.get('state'),
      code_challenge: authUrl2.searchParams.get('code_challenge'),
    },
  })
  const back2 = new URL(idpLogin2.location)
  const cb2 = await call(`/api/auth/sso/callback?connection=${CONN_ID}&code=${back2.searchParams.get('code')}&state=${back2.searchParams.get('state')}`)
  check('second SSO login works', cb2.status === 302)
  const me2 = await call('/api/admin/auth/me', { cookie: cookieOf(cb2.setCookie), redirect: 'follow' })
  check('same admin account reused (no duplicate)', me2.json?.admin?.email === 'ada@example.com' && me2.json?.admin?.id === me.json?.admin?.id)
}

// ---------- 5. Bad IdP credentials & disabled connection ----------
console.log('\n▸ 5. Failure paths')
{
  const authRes = await call(`/api/auth/sso/authorize?connection=${CONN_ID}`)
  const authUrl = new URL(authRes.location)
  const badPw = await call('/api/mock-idp/authorize', {
    method: 'POST',
    body: {
      username: 'ada@example.com',
      password: 'WRONG',
      client_id: authUrl.searchParams.get('client_id'),
      redirect_uri: authUrl.searchParams.get('redirect_uri'),
      state: authUrl.searchParams.get('state'),
      code_challenge: authUrl.searchParams.get('code_challenge'),
    },
  })
  check('IdP rejects wrong password (400)', badPw.status === 400)

  // unknown connection
  const unknown = await call('/api/auth/sso/authorize?connection=does-not-exist')
  check('unknown connection handled', unknown.status === 302 && (unknown.location ?? '').includes('error='))

  // disable the connection -> no longer on public list, authorize fails
  await call(`/api/admin/sso/connections?id=${CONN_ID}`, { cookie: SID, method: 'PATCH', body: { status: 'disabled' } })
  const pub = await call('/api/auth/sso/connections')
  check('disabled connection removed from login page', !(pub.json?.connections ?? []).some((c: any) => c.id === CONN_ID))
  const disabledAuth = await call(`/api/auth/sso/authorize?connection=${CONN_ID}`)
  check('authorize on disabled connection fails', disabledAuth.status === 302 && (disabledAuth.location ?? '').includes('error='))
  // re-enable for cleanup audit
  await call(`/api/admin/sso/connections?id=${CONN_ID}`, { cookie: SID, method: 'PATCH', body: { status: 'active' } })
}

// ---------- 6. Audit trail ----------
console.log('\n▸ 6. SSO audit trail')
{
  const audit = await call('/api/admin/audit/list?action=sso.&limit=100', { cookie: SID, redirect: 'follow' })
  const entries = audit.json?.entries ?? []
  const actions = entries.map((a: any) => a.action)
  check('sso.connection_created audited', actions.includes('sso.connection_created'))
  check('sso.user_provisioned audited', actions.includes('sso.user_provisioned'))
  check('sso.login audited', actions.includes('sso.login'))
  const prov = entries.find((a: any) => a.action === 'sso.user_provisioned')
  check('provision audit carries email + connection metadata', !!prov && JSON.stringify(prov.after ?? prov.afterJson ?? '').includes('ada@example.com'))
}

// ---------- cleanup ----------
{
  // remove test connection and the JIT admin user
  await call(`/api/admin/sso/connections?id=${CONN_ID}`, { cookie: SID, method: 'DELETE' })
  // (ada account removal would cascade sessions; leave audit history intact)
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
