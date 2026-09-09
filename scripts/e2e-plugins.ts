/**
 * GamificationOG — E2E Plugins suite (§54/§110-112, Phase 5).
 * Covers: catalog surface, manifest guards (platform version, untrusted),
 * install lifecycle, engine registration of plugin actions, event schema
 * registration, LIVE rule firing a plugin action, disable teardown,
 * uninstall, audit trail, marketplace page.
 *
 * Usage: bun scripts/e2e-plugins.ts [baseUrl]
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
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()

async function getVariable(appUserId: string, key: string) {
  const row = await db.userVariable.findUnique({ where: { appUserId_key: { appUserId, key } } })
  return row ? JSON.parse(row.valueJson) : null
}

console.log('\n════════════ GamificationOG — E2E PLUGINS ════════════')
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
    body: { name: `e2e-plugins-${Date.now()}`, scopes: ['events:write', 'state:read', 'events:read'] },
  })
  KEY = keyRes.json?.key?.key ?? ''
  check('API key created', !!KEY)
}
const authHeaders = { authorization: `Bearer ${KEY}` }

// ---------- 1. Catalog surface ----------
console.log('\n▸ 1. Marketplace catalog')
{
  const res = await call('/api/admin/plugins', { cookie: SID })
  check('plugins listed', res.status === 200)
  const ids = (res.json?.plugins ?? []).map((p: any) => p.id)
  check('skilltree + quizengine in catalog', ids.includes('com.gog.skilltree') && ids.includes('com.gog.quizengine'))
  const skilltree = res.json?.plugins?.find((p: any) => p.id === 'com.gog.skilltree')
  check('manifest fields exposed (trust, permissions, provides)', skilltree?.trust === 'first-party' && Array.isArray(skilltree?.permissions) && skilltree.provides.includes('skilltree.points'))
  check('plugin actions declared in manifest', (skilltree?.actions ?? []).some((a: any) => a.type === 'skilltree.unlock_node'))
  check('plugin events declared', (skilltree?.events ?? []).some((e: any) => e.name === 'skill.node_practiced'))
  check('nothing installed initially', (res.json?.plugins ?? []).every((p: any) => !p.installed))

  const noAuth = await call('/api/admin/plugins')
  check('plugins API requires session', noAuth.status === 401)
}

// ---------- 2. Install guards ----------
console.log('\n▸ 2. Install guards (§112 machine-validated manifests)')
{
  const unknown = await call('/api/admin/plugins', {
    cookie: SID,
    method: 'POST',
    body: { action: 'install', pluginId: 'com.example.does-not-exist' },
  })
  check('unknown plugin rejected (404)', unknown.status === 404, unknown.json?.error?.code)

  const incompatible = await call('/api/admin/plugins', {
    cookie: SID,
    method: 'POST',
    body: { action: 'install', pluginId: 'com.gog.polaris-preview' },
  })
  check('incompatible platform version rejected', incompatible.status === 422 || incompatible.status === 400, `${incompatible.status} ${incompatible.json?.error?.code}`)
  check('incompatibility error explains the version', String(incompatible.json?.error?.message ?? '').includes('platform'))
}

// ---------- 3. Install + engine registration ----------
console.log('\n▸ 3. Install skilltree → engine capabilities live')
{
  const res = await call('/api/admin/plugins', {
    cookie: SID,
    method: 'POST',
    body: { action: 'install', pluginId: 'com.gog.skilltree' },
  })
  check('install succeeds (201)', res.status === 201)
  check('registered actions returned', (res.json?.registeredActions ?? []).includes('skilltree.unlock_node'))

  const caps = await call('/api/v1/capabilities', { headers: authHeaders })
  const registry = (caps.json?.registry ?? []).map((c: any) => ({ kind: c.kind, name: c.name }))
  const actionNames = registry.filter((c: any) => c.kind === 'action').map((c: any) => c.name)
  check('plugin actions visible in capability registry', actionNames.includes('skilltree.unlock_node') && actionNames.includes('skilltree.award_points'), actionNames.filter((n: string) => n.includes('skilltree')).join(', '))

  const dupe = await call('/api/admin/plugins', {
    cookie: SID,
    method: 'POST',
    body: { action: 'install', pluginId: 'com.gog.skilltree' },
  })
  check('double install rejected (409)', dupe.status === 409, dupe.json?.error?.code)
}

// ---------- 4. Plugin event schema registered ----------
console.log('\n▸ 4. Plugin event schema registered')
{
  const scope = await call('/api/admin/plugins', { cookie: SID })
  // event schemas are project-scoped rows
  const project = await db.project.findFirst()
  const schema = await db.eventSchema.findFirst({ where: { projectId: project.id, name: 'skill.node_practiced' } })
  check('EventSchema row created for plugin event', !!schema && schema.status === 'active')
}

// ---------- 5. Live rule using a plugin action ----------
console.log('\n▸ 5. Live rule firing a plugin action (events → engine → plugin)')
const RULE_NAME = `E2E Plugin Rule ${Date.now()}`
{
  // create a rule: WHEN skill.node_practiced THEN skilltree.award_points(2)
  const created = await call('/api/admin/rules', {
    cookie: SID,
    method: 'POST',
    body: {
      name: RULE_NAME,
      description: 'E2E: award skill points on practice',
      eventType: 'skill.node_practiced',
      conditionsJson: '{"op":"and","conditions":[]}',
      actionsJson: '[{"type":"skilltree.award_points","params":{"amount":2}}]',
      priority: 1,
      status: 'active',
    },
  })
  check('rule with plugin action created', created.status === 201 || created.status === 200, `status ${created.status} ${JSON.stringify(created.json?.error ?? {}).slice(0, 80)}`)

  const user = `plugin-user-${Date.now()}`
  // identify first (SDK contract: identify → track)
  await call('/api/v1/identify', {
    headers: authHeaders,
    method: 'POST',
    body: { external_id: user, attributes: { region: 'global' } },
  })
  const evt = await call('/api/v1/events', {
    headers: authHeaders,
    method: 'POST',
    body: { external_user_id: user, event_type: 'skill.node_practiced', payload: { node: 'focus.deep_work', minutes: 15 } },
  })
  check('plugin event ingested', evt.status === 200, `status ${evt.status}`)
  const actions = evt.json?.actions ?? []
  check('plugin action fired in pipeline', actions.some((a: any) => String(a.action ?? a.type ?? '').includes('skilltree.award_points')), JSON.stringify(actions).slice(0, 100))
  const detail = actions.find((a: any) => String(a.action ?? '').includes('skilltree'))?.detail ?? ''
  check('action detail reports state change', detail.includes('Skill points'), detail.slice(0, 60))

  // verify the state actually landed
  const appUser = await db.appUser.findFirst({ where: { externalId: user } })
  const points = appUser ? await getVariable(appUser.id, 'skill_points') : null
  check('skill_points variable written by plugin action', points === 2, `points=${points}`)
}

// ---------- 6. Disable → teardown ----------
console.log('\n▸ 6. Disable teardown')
{
  const disable = await call('/api/admin/plugins', {
    cookie: SID,
    method: 'POST',
    body: { action: 'disable', pluginId: 'com.gog.skilltree' },
  })
  check('disable succeeds', disable.status === 201)

  // the plugin event schema is archived → ingesting it now fails validation
  const project = await db.project.findFirst()
  const schema = await db.eventSchema.findFirst({ where: { projectId: project.id, name: 'skill.node_practiced' } })
  check('plugin event schema archived on disable', schema?.status === 'archived')

  // creating a NEW rule referencing the plugin action must fail validation
  const badRule = await call('/api/admin/rules', {
    cookie: SID,
    method: 'POST',
    body: {
      name: `E2E Bad Plugin Rule ${Date.now()}`,
      eventType: 'task.completed',
      conditionsJson: '{"op":"and","conditions":[]}',
      actionsJson: '[{"type":"skilltree.award_points","params":{"amount":1}}]',
      priority: 1,
      status: 'draft',
    },
  })
  check('rule referencing disabled plugin action rejected', badRule.status >= 400, `status ${badRule.status} ${JSON.stringify(badRule.json?.error ?? {}).slice(0, 60)}`)

  // re-enable restores capabilities
  const enable = await call('/api/admin/plugins', {
    cookie: SID,
    method: 'POST',
    body: { action: 'enable', pluginId: 'com.gog.skilltree' },
  })
  check('re-enable succeeds', enable.status === 201)
  const schema2 = await db.eventSchema.findFirst({ where: { projectId: project.id, name: 'skill.node_practiced' } })
  check('event schema restored on re-enable', schema2?.status === 'active')
}

// ---------- 7. Uninstall + audit ----------
console.log('\n▸ 7. Uninstall + audit trail')
{
  const uninstall = await call('/api/admin/plugins', {
    cookie: SID,
    method: 'POST',
    body: { action: 'uninstall', pluginId: 'com.gog.skilltree' },
  })
  check('uninstall succeeds', uninstall.status === 201)

  const notInstalled = await call('/api/admin/plugins', {
    cookie: SID,
    method: 'POST',
    body: { action: 'disable', pluginId: 'com.gog.skilltree' },
  })
  check('actions on uninstalled plugin rejected (404)', notInstalled.status === 404)

  const audit = await call('/api/admin/audit/list?limit=60', { cookie: SID })
  const actions = (audit.json?.entries ?? []).map((a: any) => a.action)
  check('plugin.installed audited', actions.includes('plugin.installed'))
  check('plugin.disabled audited', actions.includes('plugin.disabled'))
  check('plugin.uninstalled audited', actions.includes('plugin.uninstalled'))
}

// ---------- 8. Marketplace page renders ----------
{
  const res = await fetch(`${BASE}/marketplace`)
  check('GET /marketplace responds 200', res.status === 200)
}

// ---------- cleanup ----------
{
  // remove the e2e rule
  await db.rule.deleteMany({ where: { name: RULE_NAME } })
  // remove plugin event schemas left archived
  const project = await db.project.findFirst()
  await db.eventSchema.deleteMany({ where: { projectId: project.id, name: 'skill.node_practiced' } })
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
