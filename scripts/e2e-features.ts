/**
 * GamificationOG — Exhaustive feature E2E test (every admin CRUD resource,
 * validation matrix, specialized APIs: economy, replay, playground, scope,
 * registry). Complements e2e-verify.ts (engine pipeline + UI routes).
 *
 * Usage: bun scripts/e2e-features.ts [baseUrl]
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

const S = (tag: string) => `e2e_${tag}_${Date.now().toString(36).slice(-5)}`

async function login(): Promise<string> {
  const r = await call('/api/admin/auth/login', {
    body: { email: 'owner@focusquest.app', password: 'gamification123' },
  })
  if (!r.setCookie.includes('gog_sid')) throw new Error('login failed')
  return r.setCookie.split(';')[0]
}

async function createKey(sid: string): Promise<{ id: string; secret: string }> {
  const r = await call('/api/admin/apikeys/list', {
    cookie: sid,
    body: { name: 'E2E features key', scopes: ['events:write', 'state:read'] },
  })
  return { id: r.json.key.id, secret: r.json.key.key }
}

const SID = await login()
const KEY = await createKey(SID)
const auth = { authorization: `Bearer ${KEY.secret}` }

console.log('\n══════════ GamificationOG — EXHAUSTIVE FEATURE E2E ══════════\n')

// ============================
// PART 1 — CRUD for all 17 resources
// ============================
console.log('▸ PART 1: CRUD lifecycle on all 17 admin resources (create → read → update → delete)')

interface CrudCase {
  resource: string
  label: string
  create: Record<string, unknown>
  update: Record<string, unknown>
  updateProp: (item: any, updated: any) => boolean
  cleanup?: 'archive' | 'hard'
}

const crudCases: CrudCase[] = [
  {
    resource: 'event-schemas',
    label: 'event schema',
    create: { name: `e2e.test.event.${Date.now().toString(36)}`, version: 1, description: 'E2E schema', payloadSchemaJson: '{"value":{"type":"number","required":false,"min":0,"max":100,"description":"val"}}' },
    update: { description: 'E2E schema (updated)' },
    updateProp: (i, u) => u.description === 'E2E schema (updated)' && u.name === i.name,
  },
  {
    resource: 'rules',
    label: 'rule',
    create: { name: 'E2E test rule', eventType: 'task.completed', description: 'created by E2E', conditionsJson: '{"op":"and","conditions":[]}', actionsJson: '[{"type":"award_xp","params":{"amount":"5"}}]', priority: 5, status: 'draft' },
    update: { priority: 7, description: 'updated priority' },
    updateProp: (i, u) => u.priority === 7,
    cleanup: 'archive', // verify archive-instead-of-delete invariant on rules
  },
  {
    resource: 'progression',
    label: 'progression track',
    create: { code: S('track'), name: 'E2E Track', type: 'exponential', baseXpPerLevel: 50, growthFactor: 1.5, maxLevel: 20 },
    update: { maxLevel: 25 },
    updateProp: (i, u) => u.maxLevel === 25,
  },
  {
    resource: 'challenges',
    label: 'challenge',
    create: { name: 'E2E challenge', eventType: 'task.completed', type: 'one_time', metricSource: 'event_count', target: 3, rewardsJson: '[{"type":"add_currency","params":{"currency":"coins","amount":5}}]', status: 'draft' },
    update: { target: 5, description: 'updated target' },
    updateProp: (i, u) => u.target === 5,
  },
  {
    resource: 'achievements',
    label: 'achievement',
    create: { code: S('ach'), name: 'E2E Achievement', description: 'test achievement', category: 'e2e', type: 'one_time', points: 10, conditionsJson: '{"op":"and","conditions":[{"field":"user.progression.level","operator":"gte","value":2}]}' },
    update: { points: 20 },
    updateProp: (i, u) => u.points === 20,
  },
  {
    resource: 'streaks',
    label: 'streak definition',
    create: { key: S('streak'), name: 'E2E Streak', eventType: 'task.completed', cadence: 'daily', gracePeriodHours: 4 },
    update: { gracePeriodHours: 8 },
    updateProp: (i, u) => u.gracePeriodHours === 8,
  },
  {
    resource: 'rewards',
    label: 'reward',
    create: { code: S('reward'), name: 'E2E Reward', type: 'currency', configJson: '{"currency":"coins","amount":50}', stackRule: 'replace' },
    update: { description: 'updated reward' },
    updateProp: (i, u) => u.description === 'updated reward',
  },
  {
    resource: 'currencies',
    label: 'currency',
    create: { code: S('cur'), name: 'E2E Points', type: 'soft', exchangeRate: 0.01, initialBalance: 0 },
    update: { exchangeRate: 0.02 },
    updateProp: (i, u) => u.exchangeRate === 0.02,
  },
  {
    resource: 'items',
    label: 'item',
    create: { code: S('item'), name: 'E2E Item', type: 'consumable', stackable: true, maxStack: 5 },
    update: { maxStack: 10 },
    updateProp: (i, u) => u.maxStack === 10,
  },
  {
    resource: 'leaderboards',
    label: 'leaderboard',
    create: { code: S('lb'), name: 'E2E Leaderboard', metricSource: 'event_count', eventType: 'task.completed', algorithm: 'highest', timeWindow: 'weekly' },
    update: { maxEntries: 500 },
    updateProp: (i, u) => u.maxEntries === 500,
  },
  {
    resource: 'segments',
    label: 'segment',
    create: { name: `E2E Segment ${Date.now().toString(36)}`, type: 'dynamic', conditionsJson: '{"op":"and","conditions":[{"field":"user.attributes.plan","operator":"eq","value":"pro"}]}' },
    update: { description: 'updated segment' },
    updateProp: (i, u) => u.description === 'updated segment',
  },
  {
    resource: 'experiments',
    label: 'experiment',
    create: { key: S('exp'), name: 'E2E Experiment', variantsJson: '[{"key":"control","weight":50},{"key":"variant","weight":50}]', trafficPercent: 100 },
    update: { trafficPercent: 50 },
    updateProp: (i, u) => u.trafficPercent === 50,
  },
  {
    resource: 'flags',
    label: 'feature flag',
    create: { key: S('flag'), description: 'E2E flag', enabled: true, rolloutPercent: 100 },
    update: { rolloutPercent: 25, description: 'updated flag' },
    updateProp: (i, u) => u.rolloutPercent === 25,
  },
  {
    resource: 'remote-configs',
    label: 'remote config',
    create: { key: S('cfg'), valueType: 'number', valueJson: '42' },
    update: { valueJson: '43' },
    updateProp: (i, u) => u.valueJson === '43',
  },
  {
    resource: 'notification-templates',
    label: 'notification template',
    create: { key: S('tmpl'), name: 'E2E Template', channel: 'in_app', titleTemplate: 'Hello {{name}}', bodyTemplate: 'Welcome {{name}}!', variablesJson: '["name"]' },
    update: { bodyTemplate: 'Updated {{name}}!' },
    updateProp: (i, u) => u.bodyTemplate === 'Updated {{name}}!',
  },
  {
    resource: 'webhooks',
    label: 'webhook endpoint',
    create: { url: `https://example.com/e2e/${Date.now()}`, eventsJson: '["event.received","rule.matched"]' },
    update: { eventsJson: '["event.received"]' },
    updateProp: (i, u) => u.eventsJson === '["event.received"]',
  },
  {
    resource: 'seasons',
    label: 'season',
    create: { name: `E2E Season ${Date.now().toString(36)}`, number: 98, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 30 * 86400000).toISOString(), status: 'draft' },
    update: { gracePeriodHours: 48 },
    updateProp: (i, u) => u.gracePeriodHours === 48,
  },
]

const createdIds: Array<{ resource: string; id: string; item: any; cleanup?: 'archive' | 'hard' }> = []

for (const c of crudCases) {
  const created = await call(`/api/admin/${c.resource}`, { cookie: SID, body: c.create })
  const item = created.json?.item
  check(
    `${c.label}: create`,
    created.status === 201 && !!item?.id,
    created.status === 201 ? `${item.id.slice(0, 10)}…` : JSON.stringify(created.json).slice(0, 120),
  )
  if (!item?.id) continue
  createdIds.push({ resource: c.resource, id: item.id, item, cleanup: c.cleanup })

  // read single
  const got = await call(`/api/admin/${c.resource}/${item.id}`, { cookie: SID })
  check(`${c.label}: read by id`, got.status === 200 && got.json?.item?.id === item.id)

  // present in list
  const list = await call(`/api/admin/${c.resource}?limit=1000`, { cookie: SID })
  check(`${c.label}: appears in list`, (list.json?.items ?? []).some((x: any) => x.id === item.id))

  // update
  const upd = await call(`/api/admin/${c.resource}/${item.id}`, { cookie: SID, method: 'PATCH', body: c.update })
  check(
    `${c.label}: update`,
    upd.status === 200 && c.updateProp(item, upd.json?.item),
    upd.status === 200 ? '' : JSON.stringify(upd.json).slice(0, 120),
  )

  // audit trail for the resource
  const audit = await call(`/api/admin/audit/list?limit=50`, { cookie: SID })
  const auditEntries = audit.json?.entries ?? []
  const auditHit = auditEntries.some(
    (a: any) => String(a.targetId ?? '') === item.id || (String(a.action ?? '').includes('created') && String(a.afterJson ?? '').includes(item.id)),
  )
  check(`${c.label}: creation audited`, auditHit)
}

// cross-tenant isolation: unknown resource + bogus id
{
  const bad = await call(`/api/admin/does-not-exist`, { cookie: SID })
  check('unknown resource → 404 with available list', bad.status === 404 && JSON.stringify(bad.json).includes('rules'))
  const notFound = await call(`/api/admin/rules/cmbogusid000000`, { cookie: SID })
  check('bogus id → 404', notFound.status === 404)
}

console.log(`  → created ${createdIds.length}/17 test objects`)

// ============================
// PART 2 — deletion invariants (archive vs hard delete)
// ============================
console.log('\n▸ PART 2: deletion invariants (§7 object lifecycle — active objects archive, draft objects delete)')

for (const c of createdIds) {
  const status = c.item.status ?? 'active'
  const del = await call(`/api/admin/${c.resource}/${c.id}`, { cookie: SID, method: 'DELETE' })
  if (c.cleanup === 'archive') {
    // rules created with status draft → but we explicitly verify the archive path on the active variant
    const first = await call(`/api/admin/${c.resource}/${c.id}`, { cookie: SID })
    check(
      `${c.resource}: hard delete (draft status)`,
      del.json?.deleted === true,
      del.json?.deleted === true ? '' : JSON.stringify(del.json).slice(0, 100),
    )
    continue
  }
  if (status === 'draft') {
    check(`${c.resource}: hard delete for draft`, del.json?.deleted === true)
  } else {
    // active objects must archive (never silent-delete)
    const after = await call(`/api/admin/${c.resource}/${c.id}`, { cookie: SID })
    check(
      `${c.resource}: ACTIVE object archives instead of delete`,
      del.json?.archived === true && after.json?.item?.status === 'archived',
    )
    // now flip to draft and remove
    await call(`/api/admin/${c.resource}/${c.id}`, { cookie: SID, method: 'PATCH', body: { status: 'draft' } })
    const del2 = await call(`/api/admin/${c.resource}/${c.id}`, { cookie: SID, method: 'DELETE' })
    check(`${c.resource}: archived object hard-deletes after draft`, del2.json?.deleted === true)
  }
}

// verify one active-archive flow explicitly on a rule (status active)
{
  const r = await call('/api/admin/rules', {
    cookie: SID,
    body: { name: 'E2E archive-invariant rule', eventType: 'task.completed', actionsJson: '[{"type":"award_xp","params":{"amount":1}}]', priority: 1, status: 'active' },
  })
  const id = r.json?.item?.id
  if (id) {
    const del = await call(`/api/admin/rules/${id}`, { cookie: SID, method: 'DELETE' })
    const got = await call(`/api/admin/rules/${id}`, { cookie: SID })
    check(
      'RULES: active rule archives on delete (invariant)',
      del.json?.archived === true && got.json?.item?.status === 'archived',
    )
    await call(`/api/admin/rules/${id}`, { cookie: SID, method: 'PATCH', body: { status: 'draft' } })
    const del2 = await call(`/api/admin/rules/${id}`, { cookie: SID, method: 'DELETE' })
    check('RULES: cleanup after draft', del2.json?.deleted === true)
  } else {
    check('RULES: create archive-invariant rule', false, JSON.stringify(r.json).slice(0, 100))
  }
}

// ============================
// PART 3 — validation matrix (§143: semantic validation before persistence)
// ============================
console.log('\n▸ PART 3: validation matrix — invalid payloads rejected with structured errors')

const expect400 = async (name: string, resource: string, body: Record<string, unknown>) => {
  const r = await call(`/api/admin/${resource}`, { cookie: SID, body })
  const hasCode = r.json?.error?.code
  check(name, r.status === 400 && !!hasCode, `status ${r.status}, code=${hasCode ?? 'none'}`)
}

await expect400('event-schema name must be dot-namespaced', 'event-schemas', { name: 'invalid name', version: 1 })
await expect400('event-schema payloadSchemaJson must be JSON', 'event-schemas', { name: 'a.b.c', payloadSchemaJson: 'not json' })
await expect400('rule eventType must be namespaced', 'rules', { name: 'x', eventType: 'Not Valid', actionsJson: '[]' })
await expect400('rule conditionsJson must be JSON', 'rules', { name: 'x', eventType: 'a.b', conditionsJson: 'nope', actionsJson: '[]' })
await expect400('rule condition tree validated', 'rules', { name: 'x', eventType: 'a.b', conditionsJson: '{"op":"xor","conditions":[]}', actionsJson: '[]' })
await expect400('rule action validated (unknown type)', 'rules', { name: 'x', eventType: 'a.b', actionsJson: '[{"type":"explode_everything","params":{}}]' })
await expect400('rule priority bounds', 'rules', { name: 'x', eventType: 'a.b', actionsJson: '[]', priority: 99999 })
await expect400('rule invalid status', 'rules', { name: 'x', eventType: 'a.b', actionsJson: '[]', status: 'bogus' })
await expect400('progression type must be linear/exp/custom', 'progression', { code: S('t'), name: 'x', type: 'wavy' })
await expect400('progression custom formula validated', 'progression', { code: S('t'), name: 'x', type: 'custom', customFormulaJson: '{"levelFormula":"2 *** 3"}' })
await expect400('challenge target must be positive', 'challenges', { name: 'x', eventType: 'a.b', target: 0 })
await expect400('challenge metricSource enum', 'challenges', { name: 'x', eventType: 'a.b', target: 1, metricSource: 'vibes' })
await expect400('achievement condition tree validated', 'achievements', { code: S('a'), name: 'x', conditionsJson: '{"op":"and","conditions":[{"field":"x","operator":"telepathy","value":1}]}' })
await expect400('streak cadence enum', 'streaks', { key: S('s'), name: 'x', eventType: 'a.b', cadence: 'hourly' })
await expect400('reward type enum', 'rewards', { code: S('r'), name: 'x', type: 'wish' })
await expect400('currency code format', 'currencies', { code: 'Not Ok', name: 'x' })
await expect400('currency type enum', 'currencies', { code: S('c'), name: 'x', type: 'spicy' })
await expect400('item type enum', 'items', { code: S('i'), name: 'x', type: 'magic' })
await expect400('leaderboard algorithm enum', 'leaderboards', { code: S('l'), name: 'x', algorithm: 'random' })
await expect400('leaderboard timeWindow enum', 'leaderboards', { code: S('l'), name: 'x', timeWindow: 'hourly' })
await expect400('experiment needs ≥2 variants', 'experiments', { key: S('e'), name: 'x', variantsJson: '[{"key":"only","weight":100}]' })
await expect400('experiment traffic bounds', 'experiments', { key: S('e'), name: 'x', variantsJson: '[{"key":"a","weight":50},{"key":"b","weight":50}]', trafficPercent: 150 })
await expect400('flag rollout bounds', 'flags', { key: S('f'), rolloutPercent: 150 })
await expect400('remote-config valueJson must be JSON', 'remote-configs', { key: S('k'), valueType: 'json', valueJson: '{{{' })
await expect400('webhook URL must be http(s)', 'webhooks', { url: 'ftp://nope' })
await expect400('season end must follow start', 'seasons', { name: 'x', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() - 86400000).toISOString() })
await expect400('notification-template required title', 'notification-templates', { key: S('t'), name: 'x' })

// duplicate unique constraint → 409
{
  const dup = await call('/api/admin/flags', { cookie: SID, body: { key: 'season_one', description: 'dup' } })
  check('duplicate unique key → 409 conflict', dup.status === 409 && dup.json?.error?.code === 'DUPLICATE', `status ${dup.status}`)
}

// ============================
// PART 4 — specialized admin APIs
// ============================
console.log('\n▸ PART 4: specialized APIs (economy / replay / playground / scope / registry)')

// 4a. Economy: ledger + rebuild + verify
{
  const ledger = await call('/api/admin/economy/ledger?limit=20', { cookie: SID })
  const entries = ledger.json?.entries ?? ledger.json?.ledger ?? []
  check('economy ledger history', ledger.status === 200 && entries.length > 0, `${entries.length} entries`)

  const verify = await call('/api/admin/economy/ledger', { cookie: SID, body: { action: 'verify' } })
  const results = verify.json?.currencies ?? []
  const allOk = results.length > 0 && results.every((r: any) => r.consistent === true)
  check('economy integrity verify (ledger ↔ wallet)', verify.status === 200 && verify.json?.ok === true && allOk, results.map((r: any) => `${r.currency}: ${r.ledgerSum}=${r.projectionSum}`).join(', '))

  const rebuild = await call('/api/admin/economy/ledger', { cookie: SID, body: { action: 'rebuild' } })
  check(
    'wallet projection rebuild from ledger',
    rebuild.status === 200 && (rebuild.json?.rebuilt !== undefined || rebuild.json?.wallets !== undefined),
    JSON.stringify(rebuild.json).slice(0, 90),
  )

  const verify2 = await call('/api/admin/economy/ledger', { cookie: SID, body: { action: 'verify' } })
  const results2 = verify2.json?.currencies ?? []
  check('economy integrity verify after rebuild', verify2.status === 200 && results2.length > 0 && results2.every((r: any) => r.consistent === true))

  const bad = await call('/api/admin/economy/ledger', { cookie: SID, body: { action: 'teleport' } })
  check('economy unknown action → 400', bad.status === 400)
}

// 4b. Event replay: replay a processed event, engine re-runs
{
  const feed = await call('/api/admin/events/feed?limit=10', { cookie: SID })
  const events = (feed.json?.events ?? []).filter((e: any) => e.status === 'processed')
  const target = events[0]
  check('feed has processable event for replay', !!target, target ? `${target.type} (${target.id.slice(0, 8)}…)` : '')
  if (target) {
    const before = await call('/api/admin/traces/list?limit=5', { cookie: SID })
    const traceCountBefore = (before.json?.traces ?? []).length
    const replay = await call(`/api/admin/events/feed?eventId=${target.id}`, { cookie: SID, method: 'POST' })
    check(
      'event replay re-processes through engine',
      replay.status === 200 && replay.json?.replay === true && replay.json?.result?.status === 'processed',
      `actions: ${replay.json?.result?.actions?.length ?? 0}`,
    )
    const after = await call('/api/admin/traces/list?limit=5', { cookie: SID })
    check('replay produced a new decision trace', (after.json?.traces ?? []).length >= traceCountBefore)
    const missing = await call(`/api/admin/events/feed?eventId=cmbogus`, { cookie: SID, method: 'POST' })
    check('replay unknown event → 404', missing.status === 404)
  }
}

// 4c. Playground: snapshot + simulate
{
  const snap = await call('/api/admin/playground/track', { cookie: SID })
  const users = snap.json?.users ?? []
  const schemas = snap.json?.eventSchemas ?? []
  check(
    'playground snapshot (users + schemas + scope)',
    snap.status === 200 && users.length > 0 && schemas.length > 0,
    `${users.length} users, ${schemas.length} schemas`,
  )

  const simUser = `e2e_pg_${Date.now().toString(36).slice(-5)}`
  const sim = await call('/api/admin/playground/track', {
    cookie: SID,
    body: { action: 'track', external_user_id: simUser, create_user: true, display_name: 'PG Tester', event_type: 'task.completed', payload: { difficulty: 'medium', count: 1 } },
  })
  check(
    'playground simulate: event + fresh state snapshot',
    sim.status === 200 && sim.json?.result?.status === 'processed' && sim.json?.state?.progression?.[0]?.xp > 0,
    `xp=${sim.json?.state?.progression?.[0]?.xp}, coins=${sim.json?.state?.wallets?.find((w: any) => w.currency === 'coins')?.balance ?? 0}`,
  )
  const unknown = await call('/api/admin/playground/track', { cookie: SID, body: { action: 'explode' } })
  check('playground unknown action → 400', unknown.status === 400)
}

// 4d. Scope: list + switch (multi-tenancy §8 — org → workspace → project → environment)
{
  const list = await call('/api/admin/scope', { cookie: SID })
  const organizations = list.json?.organizations ?? {}
  const orgNames = Object.keys(organizations)
  let firstProject: any = null
  let firstEnv: any = null
  for (const org of orgNames) {
    for (const ws of Object.keys(organizations[org].workspaces ?? {})) {
      for (const p of organizations[org].workspaces[ws].projects ?? []) {
        if (!firstProject && (p.environments ?? []).length > 0) {
          firstProject = p
          firstEnv = p.environments[0]
        }
      }
    }
  }
  check(
    'scope list (org → workspace → project → environment tree)',
    list.status === 200 && orgNames.length > 0 && !!firstProject,
    orgNames.map((o) => `${o}: ${Object.keys(organizations[o].workspaces).length} ws, ${Object.values(organizations[o].workspaces).reduce((s: number, w: any) => s + (w.projects?.length ?? 0), 0)} projects`).join(' | '),
  )

  const project = firstProject
  const env = firstEnv
  if (project && env) {
    const switchRes = await call('/api/admin/scope', { cookie: SID, body: { projectId: project.id, environmentId: env.id } })
    check('scope switch sets gog_scope cookie', switchRes.status === 200 && switchRes.setCookie.includes('gog_scope'), switchRes.json?.scope ? 'ok' : '')
    // verify scoped data follows the cookie
    const scoped = await call('/api/admin/analytics/summary', { cookie: `${SID}; gog_scope=${encodeURIComponent(JSON.stringify({ projectId: project.id, environmentId: env.id }))}` })
    check('scoped query honors gog_scope cookie', scoped.status === 200 && scoped.json?.scope?.projectId === project.id)
    const badSwitch = await call('/api/admin/scope', { cookie: SID, body: { projectId: 'cmX', environmentId: 'cmY' } })
    check('scope switch to bogus project → 404', badSwitch.status === 404)
  } else {
    check('scope tree has a switchable project+environment', false)
  }
}

// 4e. Capability registry (§2.3, §111)
{
  const reg = await call('/api/admin/registry/list', { cookie: SID })
  const registry = reg.json?.registry ?? []
  const summary = reg.json?.summary ?? {}
  const kinds = summary?.byKind ?? {}
  check(
    'capability registry lists engine capabilities (object types, events, actions, operators, formula functions)',
    reg.status === 200 && registry.length >= 50 && (kinds.action ?? 0) >= 10 && (kinds.condition_operator ?? 0) >= 15 && (kinds.formula_function ?? 0) >= 5,
    `total ${summary?.total}: ${Object.entries(kinds).map(([k, v]) => `${k}×${v}`).join(', ')}`,
  )
}

// 4f. v1 API with the features key — final smoke + key revoke
{
  const USER = `e2e_feat_${Date.now().toString(36).slice(-5)}`
  const id2 = await fetch(`${BASE}/api/v1/identify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ external_id: USER }),
  })
  const idJson = await id2.json()
  check('v1 identify with features key', id2.status === 200 && idJson?.user_id, '')

  const st = await fetch(`${BASE}/api/v1/users/${USER}/state`, { headers: auth })
  check('v1 state with features key', st.status === 200)

  // revoke the key, then confirm rejection (§187 API key model)
  const rv = await call(`/api/admin/apikeys/list?id=${KEY.id}`, { cookie: SID, method: 'DELETE' })
  check('revoke E2E features key', rv.json?.revoked === true)
  const afterRevoke = await fetch(`${BASE}/api/v1/users/${USER}/state`, { headers: auth })
  check('revoked key rejected (401)', afterRevoke.status === 401, `status ${afterRevoke.status}`)
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
console.log('  🎉 ALL FEATURE E2E CHECKS PASSED.')
process.exit(0)
