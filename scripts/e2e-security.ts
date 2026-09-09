/**
 * GamificationOG — End-to-end SECURITY suite (§ Advanced security).
 * Covers: security headers, login brute-force lockout, failed-login audit,
 * rate-limiter bucket semantics (unit) over the live dev server.
 *
 * Usage: bun scripts/e2e-security.ts [baseUrl]
 */
import { consume, resetLimiter, loginPolicy, recordLoginFailure, loginLockedFor, clearLoginFailures, resetLoginTracker } from '../src/server/security/limiter'

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
  return { status: res.status, json, setCookie, headers: res.headers }
}

const cookieOf = (setCookie: string) => setCookie.split(';')[0]

console.log('\n════════════ GamificationOG — E2E SECURITY ════════════')
console.log(`Target: ${BASE}\n`)

// ---------- 1. Security headers ----------
console.log('▸ 1. HTTP security headers (next.config headers())')
{
  const res = await fetch(`${BASE}/login`)
  const h = res.headers
  check('GET /login responds 200', res.status === 200)
  check('X-Frame-Options: DENY', h.get('x-frame-options') === 'DENY')
  check('X-Content-Type-Options: nosniff', h.get('x-content-type-options') === 'nosniff')
  check('Referrer-Policy set', (h.get('referrer-policy') ?? '').includes('strict-origin'))
  check('Permissions-Policy blocks camera/mic/geo', (h.get('permissions-policy') ?? '').includes('camera=()'))
  check('HSTS present', (h.get('strict-transport-security') ?? '').includes('max-age'))
  const csp = h.get('content-security-policy') ?? ''
  check('CSP includes frame-ancestors none', csp.includes("frame-ancestors 'none'"))
  check('CSP default-src self', csp.includes("default-src 'self'"))
}
{
  const res = await fetch(`${BASE}/api/v1/capabilities`)
  check('API responses also carry headers', res.headers.get('x-frame-options') === 'DENY')
}

// ---------- 2. Rate limiter semantics (unit, shared module) ----------
console.log('\n▸ 2. Token-bucket limiter semantics')
{
  resetLimiter()
  const cfg = { max: 5, windowMs: 60_000 }
  let allowed = 0
  for (let i = 0; i < 7; i++) {
    if (consume(`unit-test-key`, cfg).allowed) allowed++
  }
  check('burst of 5 allowed under max=5', allowed === 5, `allowed=${allowed}`)
  const blocked = consume('unit-test-key', cfg)
  check('6th request blocked (429 semantics)', !blocked.allowed)
  check('blocked decision has retryAfterSeconds >= 1', blocked.retryAfterSeconds >= 1, `${blocked.retryAfterSeconds}s`)
  check('blocked decision reports remaining=0', blocked.remaining === 0)
  // separate keys are isolated
  const other = consume('unit-test-other-key', cfg)
  check('separate key has its own bucket', other.allowed && other.remaining === 4)
  // refill: tiny window, wait past it
  const fast = { max: 2, windowMs: 50 }
  consume('fast-key', fast); consume('fast-key', fast)
  const deniedNow = consume('fast-key', fast)
  check('fast bucket exhausted', !deniedNow.allowed)
  await new Promise((r) => setTimeout(r, 120))
  const refilled = consume('fast-key', fast)
  check('bucket refills after window', refilled.allowed, `tokens≈${refilled.remaining}`)
  resetLimiter()
}

// ---------- 3. Login brute-force lockout (HTTP) ----------
console.log('\n▸ 3. Login brute-force lockout')
const lockEmail = `locktest-${Date.now()}@security.test`
{
  const policy = loginPolicy()
  check(`default policy max failures = ${policy.maxFailures}`, policy.maxFailures === 10, `max=${policy.maxFailures}`)
  let lastStatus = 0
  for (let i = 0; i < policy.maxFailures; i++) {
    const res = await call('/api/admin/auth/login', { body: { email: lockEmail, password: 'definitely-wrong' } })
    lastStatus = res.status
  }
  check(`${policy.maxFailures} failed logins each 401`, lastStatus === 401)
  const locked = await call('/api/admin/auth/login', { body: { email: lockEmail, password: 'definitely-wrong' } })
  check('next attempt locked out with 429', locked.status === 429, `status ${locked.status}`)
  check('429 code = LOGIN_LOCKED', locked.json?.error?.code === 'LOGIN_LOCKED', locked.json?.error?.code)
  const retryAfter = Number(locked.headers.get('retry-after') ?? '0')
  check('429 carries Retry-After header', retryAfter >= 1, `${retryAfter}s`)
  const stillLocked = await call('/api/admin/auth/login', { body: { email: lockEmail, password: 'gamification123' } })
  check('even correct password rejected while locked', stillLocked.status === 429)
}
{
  // unit: tracker clear semantics
  const p = { maxFailures: 2, windowMs: 60_000, lockMs: 60_000 }
  resetLoginTracker()
  recordLoginFailure('u:tracker', p)
  recordLoginFailure('u:tracker', p)
  check('tracker locks after maxFailures', loginLockedFor('u:tracker', p) > 0)
  clearLoginFailures('u:tracker')
  check('clearLoginFailures unlocks', loginLockedFor('u:tracker', p) === 0)
  resetLoginTracker()
}

// ---------- 4. Failed logins are audited ----------
console.log('\n▸ 4. Failed-login audit trail')
{
  const login = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  check('owner login still works', login.status === 200)
  const SID = cookieOf(login.setCookie)
  const audit = await call('/api/admin/audit/list?limit=50', { cookie: SID })
  const entries = audit.json?.entries ?? []
  const failed = entries.filter((a: any) => a.action === 'admin.login_failed' && String(a.targetId).includes('locktest-'))
  check('admin.login_failed audited for locked email', failed.length >= 10, `${failed.length} entries`)
  const actorOk = failed.every((a: any) => a.actorType === 'system')
  check('failed logins audited as system actor', actorOk)
}

// ---------- 5. Session cookie flags ----------
console.log('\n▸ 5. Session cookie hardening')
{
  const login = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusfocus.app', password: 'gamification123' },
  })
  // (invalid email on purpose — only cookie flags of real login matter)
  const login2 = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  const raw = login2.setCookie
  check('session cookie is HttpOnly', /httponly/i.test(raw))
  check('session cookie is SameSite=Lax', /samesite=lax/i.test(raw))
  check('session cookie scoped to path=/', /path=\/(;|$)/i.test(raw))
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
