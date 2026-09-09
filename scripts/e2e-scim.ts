/**
 * GamificationOG — E2E SCIM suite (§ Phase 5, RFC 7644).
 * Simulates an IdP SCIM client: token auth, user CRUD (create/query/filter/
 * replace/patch/deactivate), group (project-access) management, error
 * envelopes, audit trail, and suspended-login enforcement.
 *
 * Usage: bun scripts/e2e-scim.ts [baseUrl]
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

async function scim(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* 204 etc */
  }
  return { status: res.status, json, headers: res.headers }
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
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
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()

console.log('\n════════════ GamificationOG — E2E SCIM 2.0 ════════════')
console.log(`Target: ${BASE}\n`)

let SID = ''
{
  const login = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  check('owner login works', login.status === 200)
  SID = cookieOf(login.setCookie)
}

// ---------- 1. Token issuance & auth ----------
console.log('\n▸ 1. SCIM token auth')
let SCIM_TOKEN = ''
{
  const noAuth = await scim('/api/scim/v2/Users')
  check('no token → 401 with SCIM error envelope', noAuth.status === 401 && noAuth.json?.schemas?.[0]?.includes('Error') && noAuth.json?.status === 401)

  const badToken = await scim('/api/scim/v2/Users', { token: 'gog_scim_totallyinvalid0000000000000000000000000000' })
  check('invalid token → 401', badToken.status === 401)

  const created = await call('/api/admin/scim/tokens', {
    cookie: SID,
    method: 'POST',
    body: { name: `e2e-scim-${Date.now()}` },
  })
  check('token issued (secret once)', created.status === 201 && /^gog_scim_/.test(created.json?.token?.token ?? ''))
  SCIM_TOKEN = created.json?.token?.token ?? ''

  const ok = await scim('/api/scim/v2/ServiceProviderConfig', { token: SCIM_TOKEN })
  check('ServiceProviderConfig reachable with token', ok.status === 200)
  check('SP config advertises patch+filter', ok.json?.patch?.supported === true && ok.json?.filter?.supported === true)
  check('SP config declares bearer auth scheme', Array.isArray(ok.json?.authenticationSchemes) && ok.json.authenticationSchemes.length > 0)

  const unauthSp = await scim('/api/scim/v2/ServiceProviderConfig')
  check('ServiceProviderConfig requires token', unauthSp.status === 401)
}

// ---------- 2. User provisioning lifecycle ----------
console.log('\n▸ 2. User lifecycle (create → read → filter → patch → deactivate)')
const email = `scim-user-${Date.now()}@enterprise.test`
let USER_ID = ''
{
  const created = await scim('/api/scim/v2/Users', {
    token: SCIM_TOKEN,
    body: { userName: email, displayName: 'SCIM Provisioned', role: 'editor', active: true },
  })
  check('user created (201)', created.status === 201)
  check('Location header set', !!created.headers.get('location'))
  USER_ID = created.json?.id ?? ''
  check('resource schema is SCIM User', created.json?.schemas?.[0]?.endsWith(':User'))
  check('userName echoed', created.json?.userName === email)
  check('active=true', created.json?.active === true)
  check('role mapped (editor)', created.json?.roles?.[0]?.value === 'editor')
  check('emails structured', created.json?.emails?.[0]?.value === email && created.json?.emails?.[0]?.primary === true)

  const dupe = await scim('/api/scim/v2/Users', {
    token: SCIM_TOKEN,
    body: { userName: email },
  })
  check('duplicate userName → 409 with SCIM error', dupe.status === 409 && dupe.json?.status === 409)

  const missing = await scim('/api/scim/v2/Users', { token: SCIM_TOKEN, body: { userName: 'not-an-email' } })
  check('invalid userName → 400', missing.status === 400)

  const got = await scim(`/api/scim/v2/Users/${USER_ID}`, { token: SCIM_TOKEN })
  check('GET by id returns resource', got.status === 200 && got.json?.id === USER_ID)
  check('meta.resourceType = User', got.json?.meta?.resourceType === 'User')

  const notFound = await scim('/api/scim/v2/Users/nonexistent000', { token: SCIM_TOKEN })
  check('unknown id → 404 SCIM error', notFound.status === 404 && notFound.json?.status === 404)
}

// ---------- 3. Filtered list ----------
console.log('\n▸ 3. Filtering & pagination')
{
  const filtered = await scim(`/api/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`, {
    token: SCIM_TOKEN,
  })
  check('filter userName eq finds user', filtered.status === 200 && filtered.json?.totalResults === 1 && filtered.json?.Resources?.[0]?.userName === email)
  check('ListResponse schema present', filtered.json?.schemas?.[0]?.includes('ListResponse'))
  check('pagination fields present', filtered.json?.startIndex === 1 && typeof filtered.json?.itemsPerPage === 'number')

  const none = await scim(`/api/scim/v2/Users?filter=${encodeURIComponent('userName eq "nobody@nowhere.io"')}`, {
    token: SCIM_TOKEN,
  })
  check('filter with no match → 0 results', none.json?.totalResults === 0)

  const bad = await scim(`/api/scim/v2/Users?filter=${encodeURIComponent('userName co "x"')}`, { token: SCIM_TOKEN })
  check('unsupported filter operator → 400', bad.status === 400)
}

// ---------- 4. Patch (IdP deactivate flow) + enforcement ----------
console.log('\n▸ 4. PATCH deactivate & login enforcement')
{
  // user can log in? they have no password (SCIM-provisioned) — instead verify
  // the account is active via admin listing, then deactivate via PATCH.
  const patch = await scim(`/api/scim/v2/Users/${USER_ID}`, {
    token: SCIM_TOKEN,
    method: 'PATCH',
    body: { Operations: [{ op: 'replace', path: 'active', value: false }] },
  })
  check('PATCH active=false succeeds', patch.status === 200 && patch.json?.active === false)

  // wrong password on a suspended account must NOT reveal account state
  // (password is verified first — anti-enumeration)
  const login = await call('/api/admin/auth/login', { body: { email, password: 'whatever' } })
  check(
    'suspended account + wrong password → generic 401 (no state leak)',
    login.status === 401 && login.json?.error?.code === 'INVALID_CREDENTIALS',
    login.json?.error?.code,
  )

  // ACCOUNT_DISABLED is returned when credentials are correct but the account is suspended
  {
    const { scryptSync, randomBytes } = require('crypto')
    const salt = randomBytes(16).toString('hex')
    const suspendedEmail = `scim-disabled-${Date.now()}@enterprise.test`
    const pw = 'KnownPassword123!'
    const hash = `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`
    const probe = await db.adminUser.create({
      data: { email: suspendedEmail, name: 'Disabled Probe', passwordHash: hash, role: 'viewer', status: 'suspended' },
    })
    const loginSuspended = await call('/api/admin/auth/login', { body: { email: suspendedEmail, password: pw } })
    check(
      'correct password + suspended → 401 ACCOUNT_DISABLED',
      loginSuspended.status === 401 && loginSuspended.json?.error?.code === 'ACCOUNT_DISABLED',
      loginSuspended.json?.error?.code,
    )
    await db.adminUser.delete({ where: { id: probe.id } })
  }

  // reactivate
  const reactivate = await scim(`/api/scim/v2/Users/${USER_ID}`, {
    token: SCIM_TOKEN,
    method: 'PATCH',
    body: { Operations: [{ op: 'replace', path: 'active', value: true }] },
  })
  check('PATCH re-activate works', reactivate.status === 200 && reactivate.json?.active === true)

  const badOp = await scim(`/api/scim/v2/Users/${USER_ID}`, {
    token: SCIM_TOKEN,
    method: 'PATCH',
    body: { Operations: [{ op: 'add', path: 'active', value: true }] },
  })
  check('unsupported patch op → 400', badOp.status === 400)
}

// ---------- 5. PUT replace + DELETE (deactivate) ----------
console.log('\n▸ 5. PUT replace & SCIM DELETE semantics')
{
  const put = await scim(`/api/scim/v2/Users/${USER_ID}`, {
    token: SCIM_TOKEN,
    method: 'PUT',
    body: { userName: email, displayName: 'Renamed via SCIM', active: true, role: 'viewer' },
  })
  check('PUT updates displayName', put.json?.displayName === 'Renamed via SCIM')
  check('PUT updates role', put.json?.roles?.[0]?.value === 'viewer')

  const del = await scim(`/api/scim/v2/Users/${USER_ID}`, { token: SCIM_TOKEN, method: 'DELETE' })
  check('DELETE returns 204', del.status === 204)

  // delete = deactivate, not hard delete
  const after = await scim(`/api/scim/v2/Users/${USER_ID}`, { token: SCIM_TOKEN })
  check('resource still readable after delete', after.status === 200)
  check('delete deactivated the account', after.json?.active === false)
}

// ---------- 6. Groups → project access ----------
console.log('\n▸ 6. Groups (project access memberships)')
{
  // find the demo project slug via admin scope
  const scope = await call('/api/admin/analytics/summary', { cookie: SID })
  const groups0 = await scim('/api/scim/v2/Groups', { token: SCIM_TOKEN })
  check('Groups list responds (ListResponse)', groups0.status === 200 && groups0.json?.schemas?.[0]?.includes('ListResponse'))

  // create a group granting the (deactivated) provisioned user editor access to focusquest
  const created = await scim('/api/scim/v2/Groups', {
    token: SCIM_TOKEN,
    body: { displayName: 'project:focusquest:editor', members: [{ value: USER_ID }] },
  })
  check('group created (201)', created.status === 201)
  const GROUP_ID = created.json?.id ?? ''
  check('group resource shape', created.json?.schemas?.[0]?.endsWith(':Group') && created.json?.members?.[0]?.value === USER_ID)

  const badGroup = await scim('/api/scim/v2/Groups', {
    token: SCIM_TOKEN,
    body: { displayName: 'arbitrary-name', members: [{ value: USER_ID }] },
  })
  check('non-conforming displayName → 400', badGroup.status === 400)

  // verify membership visible on the user resource
  const user = await scim(`/api/scim/v2/Users/${USER_ID}`, { token: SCIM_TOKEN })
  check('user resource exposes group membership', (user.json?.groups ?? []).some((g: any) => g.value === GROUP_ID))

  const del = await scim(`/api/scim/v2/Groups/${GROUP_ID}`, { token: SCIM_TOKEN, method: 'DELETE' })
  check('group delete → 204', del.status === 204)
}

// ---------- 7. Audit + token lifecycle ----------
console.log('\n▸ 7. Audit trail & token revocation')
{
  const audit = await call('/api/admin/audit/list?limit=100', { cookie: SID })
  const entries = audit.json?.entries ?? []
  const actions = entries.map((a: any) => a.action)
  check('scim.user_created audited', actions.includes('scim.user_created'))
  check('scim.user_deactivated audited', actions.includes('scim.user_deactivated'))
  check('scim.group_created audited', actions.includes('scim.group_created'))
  const scimActorOk = entries
    .filter((e: any) => /^scim\.(user|group)/.test(String(e.action)))
    .every((e: any) => e.actorType === 'system' && e.actorId === 'scim')
  check('SCIM directory mutations audited as system/scim actor', scimActorOk)
  const tokenActionsAreHuman = entries
    .filter((e: any) => /^scim\.token/.test(String(e.action)))
    .every((e: any) => e.actorType === 'human')
  check('SCIM token issuance audited as human actor', tokenActionsAreHuman)

  // revoke the test token
  const listTokens = await call('/api/admin/scim/tokens', { cookie: SID })
  const tok = (listTokens.json?.tokens ?? []).find((t: any) => /^gog_scim_/.test(t.prefix + '...') && t.name.startsWith('e2e-scim-') && t.status === 'active')
  if (tok) {
    const revoked = await call(`/api/admin/scim/tokens?id=${tok.id}`, { cookie: SID, method: 'DELETE' })
    check('token revoked', revoked.status === 200)
    const denied = await scim('/api/scim/v2/Users', { token: SCIM_TOKEN })
    check('revoked token rejected (401)', denied.status === 401)
  } else {
    check('token revoked', false, 'test token not found')
  }
}

// ---------- summary ----------
console.log('\n──────────── RESULT ────────────')
console.log(`  pass: ${pass}  fail: ${fail}`)
if (failures.length) {
  console.log('  failed checks:')
  for (const f of failures) console.log(`    - ${f}`)
  await db.$disconnect()
  process.exit(1)
}
await db.$disconnect()
process.exit(0)
