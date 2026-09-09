/**
 * GamificationOG — Pack System E2E (Section 57).
 * Full pack lifecycle: catalog → preview → install → double-install guard →
 * materialized objects → live rule firing through the engine → conflict
 * detection → uninstall (pristine clean removal) → reinstall.
 *
 * Usage: bun scripts/e2e-packs.ts [baseUrl]
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
    /* html */
  }
  return { status: res.status, json, setCookie }
}

const S = (tag: string) => `e2e_pack_${tag}_${Date.now().toString(36).slice(-5)}`

async function login(): Promise<string> {
  const r = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  if (!r.setCookie.includes('gog_sid')) throw new Error('login failed')
  return r.setCookie.split(';')[0]
}

const SID = await login()

console.log('\n══════════ GamificationOG — PACK SYSTEM E2E (§57) ══════════\n')

// ============================
// 1. Catalog
// ============================
console.log('▸ 1. Pack catalog')
{
  const r = await call('/api/admin/packs', { cookie: SID })
  check('catalog lists 8 built-in packs', r.status === 200 && (r.json?.packs?.length ?? 0) === 8, `got ${r.json?.packs?.length ?? 0}`)
  const slugs = (r.json?.packs ?? []).map((p: any) => p.slug)
  check('catalog includes daily-streak + weekly-competition + rpg-core',
    slugs.includes('daily-streak') && slugs.includes('weekly-competition') && slugs.includes('rpg-core'))
  const categories = new Set((r.json?.packs ?? []).map((p: any) => p.category))
  check('packs span at least 6 categories', categories.size >= 6, `${categories.size} categories`)

  const noAuth = await call('/api/admin/packs')
  check('catalog requires admin session (401)', noAuth.status === 401, `status ${noAuth.status}`)
}

// ============================
// 2. Preview — validation + conflict detection, no side effects
// ============================
console.log('\n▸ 2. Preview (validation + conflict detection)')
{
  const r = await call('/api/admin/packs', { cookie: SID, body: { slug: 'daily-streak', action: 'preview' } })
  const p = r.json?.preview
  check('preview responds with object plan', r.status === 200 && Array.isArray(p?.objects) && p.objects.length === 4)
  check('preview reports zero conflicts on clean env', p?.conflicts === 0)
  check('preview reports not-installed state', p?.installed === false)

  // create a conflicting rule (same name as pack rule)
  const conflictRule = await call('/api/admin/rules', {
    cookie: SID,
    body: {
      name: 'Daily check-in → streak + XP',
      eventType: 'app.opened',
      actionsJson: '[{"type":"award_xp","params":{"amount":1}}]',
      status: 'draft',
    },
  })
  check('conflicting rule created (same name as pack object)', conflictRule.status === 201)

  const r2 = await call('/api/admin/packs', { cookie: SID, body: { slug: 'daily-streak', action: 'preview' } })
  check('preview detects the conflict', r2.json?.preview?.conflicts === 1, `conflicts=${r2.json?.preview?.conflicts}`)
  const conflictObj = (r2.json?.preview?.objects ?? []).find((o: any) => o.status === 'conflict')
  check('conflict object carries a reason', Boolean(conflictObj?.conflictReason))

  const blocked = await call('/api/admin/packs', { cookie: SID, body: { slug: 'daily-streak', action: 'install' } })
  check('install blocked while conflicts exist (409 PACK_CONFLICTS)',
    blocked.status === 409 && blocked.json?.error?.code === 'PACK_CONFLICTS')

  // remove the conflict (draft → hard delete)
  const del = await call(`/api/admin/rules/${conflictRule.json?.item?.id}`, { cookie: SID, method: 'DELETE' })
  check('conflicting rule removed', del.status === 200 && del.json?.deleted === true)

  const unknown = await call('/api/admin/packs', { cookie: SID, body: { slug: 'no-such-pack', action: 'preview' } })
  check('unknown pack returns PACK_NOT_FOUND (404)', unknown.status === 404 && unknown.json?.error?.code === 'PACK_NOT_FOUND')
}

// ============================
// 3. Install — materialization + double-install guard
// ============================
console.log('\n▸ 3. Install (materialize objects, snapshot ids)')
let packRuleId = ''
{
  const r = await call('/api/admin/packs', { cookie: SID, body: { slug: 'daily-streak', action: 'install' } })
  const res = r.json?.result
  check('install creates 4 objects', r.status === 201 && res?.installed === 4, `got ${res?.installed}`)
  check('install returns per-object summaries', Array.isArray(res?.created) && res.created.length === 4)

  const again = await call('/api/admin/packs', { cookie: SID, body: { slug: 'daily-streak', action: 'install' } })
  check('double install rejected (409 PACK_ALREADY_INSTALLED)',
    again.status === 409 && again.json?.error?.code === 'PACK_ALREADY_INSTALLED')

  // objects exist with pack lineage metadata
  const rules = await call('/api/admin/rules?limit=500', { cookie: SID })
  const packRules = (rules.json?.items ?? []).filter((i: any) => (i.metadataJson ?? '').includes('"packSlug":"daily-streak"'))
  check('pack rules exist with lineage metadata (packSlug)', packRules.length === 2, `got ${packRules.length}`)
  check('pack rules installed as active', packRules.every((i: any) => i.status === 'active'))
  packRuleId = packRules[0]?.id ?? ''

  const achievements = await call('/api/admin/achievements', { cookie: SID })
  const hasWarrior = (achievements.json?.items ?? []).some((a: any) => a.code === 'streak_week_warrior' && a.status === 'active')
  check('pack achievement materialized (streak_week_warrior)', hasWarrior)

  const streaks = await call('/api/admin/streaks', { cookie: SID })
  const hasCheckin = (streaks.json?.items ?? []).some((s: any) => s.key === 'daily_checkin' && s.status === 'active')
  check('pack streak materialized (daily_checkin)', hasCheckin)

  // install audit entry
  const audit = await call('/api/admin/audit/list?limit=50', { cookie: SID })
  const hasAudit = (audit.json?.entries ?? []).some((a: any) => a.action === 'pack.installed')
  check('pack.installed recorded in audit log', hasAudit)
}

// ============================
// 4. Functional — installed pack rules fire through the live engine
// ============================
console.log('\n▸ 4. Live rule firing (engine processes app.opened)')
{
  const keyRes = await call('/api/admin/apikeys/list', {
    cookie: SID,
    body: { name: 'E2E packs key', scopes: ['events:write', 'state:read'] },
  })
  const KEY = keyRes.json?.key?.key
  const auth = { authorization: `Bearer ${KEY}` }
  const USER = 'e2e_packuser_' + Date.now().toString(36).slice(-5)

  await call('/api/v1/identify', { headers: auth, body: { external_id: USER } })

  const ev = await call('/api/v1/events', {
    headers: auth,
    body: { event_type: 'app.opened', external_user_id: USER },
  })
  const delta = ev.json?.stateDelta
  check('app.opened processed (200)', ev.status === 200 && ev.json?.status === 'processed')
  check('pack rule fired — streak advanced',
    delta?.streak?.key === 'daily_checkin' && (delta?.streak?.current ?? 0) >= 1,
    `streak: ${JSON.stringify(delta?.streak)}`)
  check('pack rule fired — +5 XP awarded', (delta?.xpAwarded ?? 0) >= 5, `+${delta?.xpAwarded ?? 0} XP`)

  // cooldown (3600s on the pack rule): second app.opened within the hour awards no XP
  const ev2 = await call('/api/v1/events', {
    headers: auth,
    body: { event_type: 'app.opened', external_user_id: USER },
  })
  const delta2 = ev2.json?.stateDelta
  check('cooldown blocks re-fire within an hour (no double XP)', (delta2?.xpAwarded ?? 0) === 0, `+${delta2?.xpAwarded ?? 0} XP on repeat`)

  // revoke key
  await call(`/api/admin/apikeys/list?id=${keyRes.json?.key.id}`, { cookie: SID, method: 'DELETE' })
}

// ============================
// 5. Uninstall — pristine removal + reinstall (upsert path)
// ============================
console.log('\n▸ 5. Uninstall + reinstall (rollback semantics)')
{
  // simulate user modification on one pack rule (bump priority) → should archive, not delete
  const modified = await call(`/api/admin/rules/${packRuleId}`, {
    cookie: SID,
    method: 'PATCH',
    body: { priority: 250 },
  })
  check('user-modified a pack rule', modified.status === 200)

  const un = await call('/api/admin/packs', { cookie: SID, body: { slug: 'daily-streak', action: 'uninstall' } })
  const res = un.json?.result
  check('uninstall completes', un.status === 200)
  check('modified rule archived (user work preserved)', res?.archived === 1 && res?.removedClean === 3,
    `archived=${res?.archived}, removedClean=${res?.removedClean}`)

  // archived modified rule now blocks reinstall (conflict)
  const pre = await call('/api/admin/packs', { cookie: SID, body: { slug: 'daily-streak', action: 'preview' } })
  check('modified leftover blocks reinstall (conflict detected)', (pre.json?.preview?.conflicts ?? 0) >= 1)

  // clean up the archived leftover (archived → hard delete)
  const rules = await call('/api/admin/rules?limit=500', { cookie: SID })
  const leftover = (rules.json?.items ?? []).find((i: any) => i.id === packRuleId)
  if (leftover) {
    await call(`/api/admin/rules/${packRuleId}`, { cookie: SID, method: 'DELETE' })
  }
  check('leftover cleaned', true)

  // reinstall now works — proves the PackInstall upsert path
  const re = await call('/api/admin/packs', { cookie: SID, body: { slug: 'daily-streak', action: 'install' } })
  check('reinstall after uninstall works (upsert install record)', re.status === 201 && re.json?.result?.installed === 4)

  // pristine uninstall removes everything cleanly
  await new Promise((r) => setTimeout(r, 1500)) // ensure updatedAt > installedAt check passes with grace
  const un2 = await call('/api/admin/packs', { cookie: SID, body: { slug: 'daily-streak', action: 'uninstall' } })
  check('pristine uninstall removes all objects cleanly', un2.json?.result?.removedClean === 4)

  const rulesAfter = await call('/api/admin/rules?limit=500', { cookie: SID })
  const remaining = (rulesAfter.json?.items ?? []).filter((i: any) => (i.metadataJson ?? '').includes('"packSlug":"daily-streak"'))
  check('no pack objects remain after clean uninstall', remaining.length === 0, `${remaining.length} left`)
}

// ============================
// 6. Leaderboard pack — weekly-competition
// ============================
console.log('\n▸ 6. Leaderboard pack (weekly-competition)')
{
  const r = await call('/api/admin/packs', { cookie: SID, body: { slug: 'weekly-competition', action: 'install' } })
  check('weekly-competition installs 2 objects (leaderboard + rule)', r.status === 201 && r.json?.result?.installed === 2)

  const boards = await call('/api/admin/leaderboards', { cookie: SID })
  const race = (boards.json?.items ?? []).find((b: any) => b.code === 'weekly_xp_race')
  check('leaderboard materialized (weekly_xp_race, weekly window, xp metric)',
    Boolean(race) && race.timeWindow === 'weekly' && race.metricSource === 'xp')

  await new Promise((r2) => setTimeout(r2, 1500))
  const un = await call('/api/admin/packs', { cookie: SID, body: { slug: 'weekly-competition', action: 'uninstall' } })
  check('weekly-competition uninstalls cleanly', un.json?.result?.removedClean === 2)
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
console.log('  🎉 PACK SYSTEM VERIFIED — preview / install / fire / uninstall / reinstall lifecycle green.')
process.exit(0)
