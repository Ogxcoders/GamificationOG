/**
 * GamificationOG — E2E Environment Promotion suite (§ Mode C, Phase 5).
 * Covers: environment surface, guards (self/unknown), dry-run diff without
 * side effects, real promotion (validated + transactional), idempotent
 * re-promotion, CLI parity, audit lineage.
 *
 * Usage: bun scripts/e2e-promote.ts [baseUrl]
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

async function countIn(envName: string): Promise<number> {
  const env = await db.environment.findFirst({ where: { name: envName } })
  if (!env) return -1
  return db.rule.count({ where: { environmentId: env.id } })
}

async function findRuleIn(envName: string, ruleName: string) {
  const env = await db.environment.findFirst({ where: { name: envName } })
  if (!env) return null
  return db.rule.findFirst({ where: { environmentId: env.id, name: ruleName } })
}

console.log('\n════════════ GamificationOG — E2E ENVIRONMENT PROMOTION ════════════')
console.log(`Target: ${BASE}\n`)

let SID = ''
{
  const login = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  check('owner login works', login.status === 200)
  SID = cookieOf(login.setCookie)
}

// ---------- 1. Surface + guards ----------
console.log('\n▸ 1. Promotion surface + guards')
{
  const get = await call('/api/admin/promote', { cookie: SID })
  check('GET lists environments', get.status === 200 && Array.isArray(get.json?.environments) && get.json.environments.length >= 2)
  check('GET reports current environment', typeof get.json?.current === 'string')

  const self = await call('/api/admin/promote', { cookie: SID, method: 'POST', body: { from: 'staging', to: 'staging', dryRun: true } })
  check('self-promotion rejected (PROMOTE_SELF)', self.status === 400 && self.json?.error?.code === 'PROMOTE_SELF')

  const unknown = await call('/api/admin/promote', { cookie: SID, method: 'POST', body: { from: 'development', to: 'canary', dryRun: true } })
  check('unknown environment rejected with fix hint', unknown.status === 404 && unknown.json?.error?.code === 'ENVIRONMENT_NOT_FOUND' && String(unknown.json?.error?.fix ?? '').includes('development'))

  const noAuth = await call('/api/admin/promote', { method: 'POST', body: { from: 'development', to: 'staging' } })
  check('promotion requires admin session', noAuth.status === 401)
}

// ---------- 2. Dry-run diff (no side effects) ----------
console.log('\n▸ 2. Dry-run diff')
{
  const beforeStaging = await countIn('staging')
  const dry = await call('/api/admin/promote', {
    cookie: SID,
    method: 'POST',
    body: { from: 'development', to: 'staging', dryRun: true },
  })
  check('dry-run succeeds', dry.status === 200)
  check('dry-run flagged', dry.json?.dryRun === true && dry.json?.applied === false)
  check('diff summary present', typeof dry.json?.summary?.create === 'number')
  const afterStaging = await countIn('staging')
  check('dry-run leaves target untouched', beforeStaging === afterStaging, `${beforeStaging} rules before/after`)
}

// ---------- 3. Real promotion ----------
console.log('\n▸ 3. Promotion (development → staging)')
{
  const devRule = await findRuleIn('development', 'Complete task → XP + Coins')
  const applied = await call('/api/admin/promote', {
    cookie: SID,
    method: 'POST',
    body: { from: 'development', to: 'staging', dryRun: false },
  })
  check('promotion succeeds (201)', applied.status === 201)
  check('applied flag set', applied.json?.applied === true)
  const created = applied.json?.summary?.create ?? 0
  check('promotion created objects in target', created > 0, `${created} created`)

  const stagingRules = await countIn('staging')
  check('rules now exist in staging', stagingRules > 0, `${stagingRules} rules`)
  const promotedRule = await findRuleIn('staging', 'Complete task → XP + Coins')
  check('specific rule promoted with config parity', !!promotedRule && (!devRule || promotedRule.actionsJson === devRule.actionsJson))

  // idempotent re-promotion → all identical, zero creates
  const again = await call('/api/admin/promote', {
    cookie: SID,
    method: 'POST',
    body: { from: 'development', to: 'staging', dryRun: false },
  })
  check('re-promotion is idempotent (0 creates)', (again.json?.summary?.create ?? 1) === 0, `create=${again.json?.summary?.create}`)
  check('re-promotion reports identical objects', (again.json?.summary?.identical ?? 0) > 0)
}

// ---------- 4. Audit lineage ----------
console.log('\n▸ 4. Audit lineage')
{
  const audit = await call('/api/admin/audit/list?limit=50', { cookie: SID })
  const entries = audit.json?.entries ?? []
  const promos = entries.filter((e: any) => e.action === 'environment.promoted')
  check('environment.promoted audited', promos.length >= 1)
  const last = promos[0]
  check('audit records from/to + summary', String(JSON.stringify(last?.after ?? last?.afterJson ?? '')).includes('development') && String(JSON.stringify(last?.after ?? '')).includes('staging'))
}

// ---------- 5. CLI parity ----------
console.log('\n▸ 5. CLI parity (bun run gog promote)')
{
  const proc = Bun.spawnSync([
    'bun', 'scripts/cli.ts', 'promote',
    '--from', 'staging', '--to', 'production', '--dry-run',
    '--email', 'owner@focusquest.app', '--password', 'gamification123',
    '--base', BASE,
  ])
  const out = proc.stdout.toString()
  const okRun = proc.exitCode === 0
  check('CLI promote dry-run exits 0', okRun, out.split('\n').slice(-3).join(' ').slice(0, 90))
  check('CLI shows promotion header', out.includes('Environment promotion') && out.includes('staging → production'))
  check('CLI shows diff counters', /\d+ create/.test(out))

  const prodBefore = await countIn('production')
  check('CLI dry-run left production untouched', prodBefore === 0, `${prodBefore} rules`)
}

// ---------- cleanup ----------
{
  // staging/production start empty (verified) — remove everything the promotion
  // created so other suites see pristine state. Event schemas are project-scoped
  // (shared, pre-existing) and are intentionally left untouched.
  const envScoped = [
    'rule', 'progressionTrack', 'challenge', 'achievement', 'streak',
    'reward', 'currency', 'item', 'leaderboard', 'segment',
  ] as const
  for (const envName of ['staging', 'production']) {
    const env = await db.environment.findFirst({ where: { name: envName } })
    if (!env) continue
    for (const model of envScoped) {
      // @ts-expect-error dynamic prisma delegate access
      await db[model].deleteMany({ where: { environmentId: env.id } })
    }
  }
  await db.$disconnect()
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
