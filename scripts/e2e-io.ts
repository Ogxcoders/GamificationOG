/**
 * GamificationOG — Import/Export E2E (Sections 59-60).
 * Round-trip fidelity, diff/conflict detection, dry-run preview,
 * apply with skip/overwrite strategies, transactional audit.
 *
 * Usage: bun scripts/e2e-io.ts [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://localhost:3000'

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`    ✅ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`    ❌ ${name}${detail ? ` — ${detail}` : ''}`)
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
    /* html */
  }
  return { status: res.status, json, setCookie }
}

async function login(): Promise<string> {
  const r = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  if (!r.setCookie.includes('gog_sid')) throw new Error('login failed')
  return r.setCookie.split(';')[0]
}

const SID = await login()

console.log('\n══════════ GamificationOG — IMPORT / EXPORT E2E (§59-60) ══════════\n')

// ============================
// 1. Export
// ============================
console.log('▸ 1. Export — portable package with manifest')
let pkg: any
{
  const r = await call('/api/admin/export', { cookie: SID })
  pkg = r.json
  check('export responds 200', r.status === 200)
  check('manifest declares kind + version', pkg?.manifest?.kind === 'gamificationog.gamification-system' && pkg?.manifest?.packageVersion === 1)
  check('manifest carries provenance', typeof pkg?.manifest?.project === 'string' && typeof pkg?.manifest?.exportedAt === 'string')
  check('manifest counts match resource contents',
    Object.entries(pkg?.manifest?.counts ?? {}).every(([k, n]: [string, any]) => (pkg.resources[k] ?? []).length === n))
  check('rules exported with natural keys + config fields',
    (pkg?.resources?.rules ?? []).length > 0 && pkg.resources.rules.every((r: any) => r.name && r.eventType && r.actionsJson && !r.id))
  check('internal ids and timestamps stripped',
    Object.values(pkg?.resources ?? {}).flat().every((o: any) => o.id === undefined && o.createdAt === undefined))

  const noAuth = await call('/api/admin/export')
  check('export requires admin session (401)', noAuth.status === 401, `status ${noAuth.status}`)

  const download = await fetch(`${BASE}/api/admin/export?download=1`, { headers: { cookie: SID } })
  const disposition = download.headers.get('content-disposition') ?? ''
  check('download mode sets attachment disposition', disposition.includes('attachment') && disposition.includes('.json'))
}

// ============================
// 2. Identity dry-run — perfect round-trip
// ============================
console.log('\n▸ 2. Dry-run identity import (round-trip fidelity)')
{
  const r = await call('/api/admin/import', { cookie: SID, body: { package: pkg, mode: 'dry-run' } })
  const p = r.json?.preview
  check('dry-run responds with plan', r.status === 200 && Array.isArray(p?.objects))
  check('identity import: everything identical, nothing to change',
    p?.summary?.create === 0 && p?.summary?.overwrite === 0 && p?.summary?.skip === 0 && (p?.summary?.identical ?? 0) > 40,
    `summary=${JSON.stringify(p?.summary)}`)
}

// ============================
// 3. Validation + compatibility guards
// ============================
console.log('\n▸ 3. Package validation + compatibility (§60)')
{
  const wrongKind = await call('/api/admin/import', { cookie: SID, body: { package: { manifest: { kind: 'something.else', packageVersion: 1 } } } })
  check('wrong kind rejected (IMPORT_INCOMPATIBLE)', wrongKind.status === 400 && wrongKind.json?.error?.code === 'IMPORT_INCOMPATIBLE')

  const future = await call('/api/admin/import', { cookie: SID, body: { package: { manifest: { kind: 'gamificationog.gamification-system', packageVersion: 99 } } } })
  check('newer package version rejected', future.json?.error?.code === 'IMPORT_INCOMPATIBLE')

  const noManifest = await call('/api/admin/import', { cookie: SID, body: { package: { resources: {} } } })
  check('missing manifest rejected', noManifest.status === 400 && noManifest.json?.error?.code === 'IMPORT_INVALID_PACKAGE')

  const missingField = await call('/api/admin/import', { cookie: SID, body: { mode: 'dry-run' } })
  check('missing package field rejected (400)', missingField.status === 400)

  // invalid object inside package → skipped with warning, not a crash
  const pkgWithBad = JSON.parse(JSON.stringify(pkg))
  pkgWithBad.resources.rules.push({ name: 'Broken Rule', eventType: 'not-a-valid-event-type!!', actionsJson: [] })
  const bad = await call('/api/admin/import', { cookie: SID, body: { package: pkgWithBad, mode: 'dry-run' } })
  const badObj = (bad.json?.preview?.objects ?? []).find((o: any) => o.naturalKey === 'Broken Rule')
  check('invalid object skipped with reason, rest of package still planned',
    badObj?.action === 'skip' && (bad.json?.preview?.warnings?.length ?? 0) > 0, `reason: ${badObj?.reason?.slice(0, 60)}`)

  const noAuth = await call('/api/admin/import', { body: { package: pkg } })
  check('import requires admin session (401)', noAuth.status === 401, `status ${noAuth.status}`)
}

// ============================
// 4. Modified package — diff + strategies
// ============================
console.log('\n▸ 4. Diff + strategies (skip / overwrite)')
const modified = JSON.parse(JSON.stringify(pkg))
{
  // modify one rule (priority), add one new rule + achievement
  for (const r of modified.resources.rules) {
    if (r.name === 'Complete task → XP + Coins') r.priority = 777
  }
  modified.resources.rules.push({
    name: 'E2E IO Imported Rule',
    description: 'created by import e2e',
    eventType: 'io.test.event',
    conditionsJson: { op: 'and', conditions: [] },
    actionsJson: [{ type: 'award_xp', params: { amount: 13 } }],
    priority: 500,
    status: 'draft',
  })
  modified.resources.achievements.push({
    code: 'e2e_io_imported_achievement',
    name: 'E2E IO Imported Achievement',
    description: 'created by import e2e',
    category: 'general',
    type: 'one_time',
    conditionsJson: { progressField: 'user.level', progressTarget: 99 },
    points: 7,
    rewardsJson: [],
    hidden: false,
    status: 'active',
  })

  const skip = await call('/api/admin/import', { cookie: SID, body: { package: modified, mode: 'dry-run', strategy: 'skip' } })
  const sp = skip.json?.preview
  check('skip strategy: 2 create + 1 skip (diverged) + rest identical',
    sp?.summary?.create === 2 && sp?.summary?.skip === 1 && (sp?.summary?.identical ?? 0) > 40,
    `summary=${JSON.stringify(sp?.summary)}`)
  const skipObj = (sp?.objects ?? []).find((o: any) => o.naturalKey === 'Complete task → XP + Coins')
  check('diverged object marked skip with reason', skipObj?.action === 'skip' && Boolean(skipObj?.reason))

  const ow = await call('/api/admin/import', { cookie: SID, body: { package: modified, mode: 'dry-run', strategy: 'overwrite' } })
  const op = ow.json?.preview
  check('overwrite strategy: diverged object becomes overwrite',
    op?.summary?.create === 2 && op?.summary?.overwrite === 1 && op?.summary?.skip === 0,
    `summary=${JSON.stringify(op?.summary)}`)
}

// ============================
// 5. Apply — skip, then overwrite
// ============================
console.log('\n▸ 5. Apply (transactional + audited)')
{
  const applySkip = await call('/api/admin/import', { cookie: SID, body: { package: modified, mode: 'apply', strategy: 'skip' } })
  check('apply (skip) succeeds', applySkip.status === 200 && applySkip.json?.result?.applied === true)

  // only the 2 new objects created; diverged rule untouched
  const rules = await call('/api/admin/rules?limit=500', { cookie: SID })
  const byName = Object.fromEntries((rules.json?.items ?? []).map((i: any) => [i.name, i]))
  check('imported rule created (draft)', byName['E2E IO Imported Rule']?.status === 'draft')
  check('diverged rule NOT overwritten under skip strategy', byName['Complete task → XP + Coins']?.priority === 100,
    `priority=${byName['Complete task → XP + Coins']?.priority}`)

  const achievements = await call('/api/admin/achievements', { cookie: SID })
  const importedAch = (achievements.json?.items ?? []).find((a: any) => a.code === 'e2e_io_imported_achievement')
  check('imported achievement created (progress-style condition preserved)',
    importedAch?.status === 'active' && String(importedAch?.conditionsJson ?? '').includes('progressField'))

  // second apply with overwrite → updates the diverged rule
  const applyOw = await call('/api/admin/import', { cookie: SID, body: { package: modified, mode: 'apply', strategy: 'overwrite' } })
  check('apply (overwrite) succeeds', applyOw.status === 200)

  const rules2 = await call('/api/admin/rules?limit=500', { cookie: SID })
  const byName2 = Object.fromEntries((rules2.json?.items ?? []).map((i: any) => [i.name, i]))
  check('diverged rule overwritten (priority 100 → 777)', byName2['Complete task → XP + Coins']?.priority === 777,
    `priority=${byName2['Complete task → XP + Coins']?.priority}`)

  // audit entries
  const audit = await call('/api/admin/audit/list?limit=20', { cookie: SID })
  const imports = (audit.json?.entries ?? []).filter((e: any) => e.action === 'import.applied')
  check('import.applied audited (2 entries: skip + overwrite)', imports.length >= 2)

  // idempotent re-apply: everything identical now
  const again = await call('/api/admin/import', { cookie: SID, body: { package: modified, mode: 'dry-run', strategy: 'overwrite' } })
  check('re-import is fully idempotent (0 changes)', again.json?.preview?.summary?.create === 0 && again.json?.preview?.summary?.overwrite === 0)

  // cleanup: remove imported objects + restore priority
  await call(`/api/admin/rules/${byName2['E2E IO Imported Rule'].id}`, { cookie: SID, method: 'DELETE' })
  await call(`/api/admin/achievements/${importedAch.id}`, { cookie: SID, method: 'DELETE' })
  await call(`/api/admin/rules/${byName2['Complete task → XP + Coins'].id}`, { cookie: SID, method: 'PATCH', body: { priority: 100 } })
  const rulesFinal = await call('/api/admin/rules?limit=500', { cookie: SID })
  const finalByName = Object.fromEntries((rulesFinal.json?.items ?? []).map((i: any) => [i.name, i]))
  check('cleanup: state restored (priority 100, imported objects gone)',
    finalByName['Complete task → XP + Coins']?.priority === 100 && !finalByName['E2E IO Imported Rule'])
}

// ============================
// summary
// ============================
console.log('\n════════════════════════════════════════════════════════════════')
console.log(`  RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(`  Failed: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('  🎉 IMPORT/EXPORT VERIFIED — portable packages with dry-run diff, strategies, and transactional apply.')
process.exit(0)
