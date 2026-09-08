/**
 * GamificationOG — Monetization vertical E2E (§328 fourth vertical slice):
 * Offer → Paywall → Checkout → Subscription → Entitlement, plus
 * personalization overrides and live webhook delivery with HMAC
 * signatures + retry/redelivery.
 *
 * Usage: bun scripts/e2e-monetization.ts [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://localhost:3000'
const HOOK_PORT = 4599

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
    console.log(`    ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function call(path: string, opts: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
  if (opts.cookie) headers.cookie = opts.cookie
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* html */
  }
  return { status: res.status, json }
}

const ts = Date.now().toString(36).slice(-5)

// ---------- local webhook receiver ----------
const hookLog: Array<{ headers: Record<string, string>; body: any }> = []
let hookMode: 'ok' | 'fail' | 'flaky' = 'ok'
let flakyCount = 0
const hookServer = Bun.serve({
  port: HOOK_PORT,
  async fetch(req) {
    const body = await req.json().catch(() => ({}))
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    hookLog.push({ headers, body })
    if (hookMode === 'fail') return new Response('boom', { status: 500 })
    if (hookMode === 'flaky') {
      flakyCount++
      if (flakyCount <= 2) return new Response('flaky fail', { status: 500 })
    }
    return new Response('ok', { status: 200 })
  },
})

// ---------- setup ----------
const loginRes = await call('/api/admin/auth/login', { body: { email: 'owner@focusquest.app', password: 'gamification123' } })
const SID = (loginRes.setCookieFromLogin ?? '') || ''
// re-fetch cookie properly
const login2 = await fetch(`${BASE}/api/admin/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner@focusquest.app', password: 'gamification123' }),
})
const SID_COOKIE = (login2.headers.get('set-cookie') ?? '').split(';')[0]

const keyRes = await call('/api/admin/apikeys/list', {
  cookie: SID_COOKIE,
  body: { name: 'E2E monetization key', scopes: ['events:write', 'state:read'] },
})
const KEY = keyRes.json?.key?.key ?? ''
const KEY_ID = keyRes.json?.key?.id ?? ''
const auth = { authorization: `Bearer ${KEY}` }

console.log('\n══════════ GamificationOG — MONETIZATION VERTICAL E2E ══════════\n')

const USER = `buyer_${ts}`

// ---------- 1. personalization (§34) ----------
console.log('▸ 1. Personalization — targeted config overrides')
{
  await fetch(`${BASE}/api/v1/identify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ external_id: USER, display_name: 'Buyer E2E', attributes: { plan: 'free', country: 'IN' } }),
  })

  const free = await call(`/api/v1/flags?user=${USER}`, { headers: auth })
  check('free/low-level user gets base config (5000)', free.json?.config?.daily_xp_cap === 5000, `cap=${free.json?.config?.daily_xp_cap}, overridden=[${free.json?.config_overridden}]`)

  // ada has plan=pro → 8000 (priority 200 rule)
  const ada = await call(`/api/v1/flags?user=ada`, { headers: auth })
  check('pro user gets personalized cap (8000)', ada.json?.config?.daily_xp_cap === 8000, `cap=${ada.json?.config?.daily_xp_cap}`)

  // another fresh free/low-level user → base config (pro rule must not leak)
  await fetch(`${BASE}/api/v1/identify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ external_id: `lurker_${ts}`, attributes: { plan: 'free', country: 'US' } }),
  })
  const lurker = await call(`/api/v1/flags?user=lurker_${ts}`, { headers: auth })
  check('fresh free user unaffected by pro rule', lurker.json?.config?.daily_xp_cap === 5000, `cap=${lurker.json?.config?.daily_xp_cap}`)

  // dynamic: create a rule targeting the test user by attribute, verify override applies
  const rule = await call('/api/admin/personalization-rules', {
    cookie: SID_COOKIE,
    body: {
      key: 'daily_xp_cap', valueJson: JSON.stringify({ value: 1234 }),
      targetingJson: JSON.stringify({ op: 'and', conditions: [{ field: 'user.attribute.country', operator: 'eq', value: 'IN' }] }),
      priority: 500, description: 'E2E dynamic override', status: 'active',
    },
  })
  check('personalization rule created via admin CRUD', rule.status === 201, rule.json?.item?.id?.slice(0, 8))
  const mine = await call(`/api/v1/flags?user=${USER}`, { headers: auth })
  check('dynamic override applied live', mine.json?.config?.daily_xp_cap === 1234, `cap=${mine.json?.config?.daily_xp_cap}, overridden=[${mine.json?.config_overridden}]`)
  // cleanup: archive + delete the rule
  const rid = rule.json?.item?.id
  if (rid) {
    await call(`/api/admin/personalization-rules/${rid}`, { cookie: SID_COOKIE, method: 'PATCH', body: { status: 'draft' } })
    await call(`/api/admin/personalization-rules/${rid}`, { cookie: SID_COOKIE, method: 'DELETE' })
  }
  const after = await call(`/api/v1/flags?user=${USER}`, { headers: auth })
  check('override removed after rule deletion', after.json?.config?.daily_xp_cap === 5000)
}

// ---------- 2. paywall evaluation (§43/44) ----------
console.log('\n▸ 2. Paywall evaluation — entitlement gating + targeting')
{
  // USER is a fresh level-1 user → wall targeting (level ≥ 3) doesn't match → not locked
  const low = await call(`/api/v1/paywall?user=${USER}&code=advanced_analytics`, { headers: auth })
  check('wall does not apply below level 3 (targeting)', low.status === 200 && low.json?.locked === false, `locked=${low.json?.locked}`)

  // level USER up with events
  for (let i = 0; i < 6; i++) {
    await fetch(`${BASE}/api/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ event_type: 'task.completed', external_user_id: USER, payload: { difficulty: 'hard', count: 1 } }),
    })
  }
  const locked = await call(`/api/v1/paywall?user=${USER}&code=advanced_analytics`, { headers: auth })
  check(
    'level-3+ user without entitlement hits the locked wall with offers',
    locked.json?.locked === true && locked.json?.entitlement === 'pro' && (locked.json?.offers?.length ?? 0) > 0,
    `locked=${locked.json?.locked}, offers=${locked.json?.offers?.map((o: any) => `${o.code}@$${o.pricing?.amount}`).join(', ')}`,
  )
  check('paywall carries client rendering config', !!locked.json?.config?.title && !!locked.json?.config?.cta)

  // ada has pro entitlement → never locked
  const ada = await call(`/api/v1/paywall?user=ada&code=advanced_analytics`, { headers: auth })
  check('entitled user passes (not locked)', ada.json?.locked === false)

  const missing = await call(`/api/v1/paywall?user=${USER}&code=no_such_wall`, { headers: auth })
  check('unknown paywall → 404', missing.status === 404)
}

// ---------- 3. checkout → subscription → entitlement (§41/39/40) ----------
console.log('\n▸ 3. Checkout flow — offer pricing → subscription → entitlement')
let sessionId = ''
{
  const created = await call('/api/v1/checkout', {
    headers: auth,
    body: { user: USER, product_code: 'focus_pro', offer_code: 'pro_launch_40' },
  })
  const price = created.json?.price
  sessionId = created.json?.session_id ?? ''
  check(
    'checkout session created with offer pricing (5.99 vs 9.99 base)',
    created.status === 201 && price?.amount === 5.99 && price?.originalAmount === 9.99 && price?.offerCode === 'pro_launch_40',
    `$${price?.amount} (was $${price?.originalAmount})`,
  )

  // buyer has plan=free → sees the launch offer in v1 monetization
  const m = await call(`/api/v1/monetization?user=${USER}`, { headers: auth })
  check(
    'v1 monetization lists targeted offers for user',
    m.status === 200 && m.json?.offers?.some((o: any) => o.code === 'pro_launch_40'),
    `${m.json?.offers?.length} offers: ${m.json?.offers?.map((o: any) => o.code).join(', ')}`,
  )

  // USER was leveled in §2 → wall is locked now (no entitlement yet)
  const wall = await call(`/api/v1/paywall?user=${USER}&code=advanced_analytics`, { headers: auth })
  check('buyer locked before purchase', wall.json?.locked === true, `locked=${wall.json?.locked}`)

  const completed = await call('/api/v1/checkout/complete', { headers: auth, body: { session_id: sessionId } })
  const subStatus = completed.json?.subscription?.status
  check(
    'checkout completed → subscription (trial) + entitlement granted',
    completed.json?.status === 'completed' && (subStatus === 'active' || subStatus === 'trialing') && completed.json?.entitlement?.code === 'pro',
    `sub status=${subStatus}, until ${completed.json?.subscription?.currentPeriodEnd?.slice(0, 10)}`,
  )

  // exactly-once (§201)
  const again = await call('/api/v1/checkout/complete', { headers: auth, body: { session_id: sessionId } })
  check('double completion rejected (exactly-once)', again.status === 409, `code=${again.json?.error?.code}`)

  // wall now unlocked
  const wall2 = await call(`/api/v1/paywall?user=${USER}&code=advanced_analytics`, { headers: auth })
  check('paywall unlocked after purchase', wall2.json?.locked === false)
  const state = await call(`/api/v1/users/${USER}/state`, { headers: auth })
  check(
    'user state includes entitlements + subscriptions',
    state.status === 200 && state.json?.entitlements?.some((e: any) => e.code === 'pro' && e.status === 'active') && state.json?.subscriptions?.length === 1,
    `entitlements: ${state.json?.entitlements?.map((e: any) => e.code).join(', ')}`,
  )

  // failed checkout outcome path
  const failSess = await call('/api/v1/checkout', { headers: auth, body: { user: USER, product_code: 'focus_pro', tier: 'yearly' } })
  const failed = await call('/api/v1/checkout/complete', { headers: auth, body: { session_id: failSess.json?.session_id, outcome: 'failure' } })
  check('failed outcome recorded', failed.json?.status === 'failed')

  const badProduct = await call('/api/v1/checkout', { headers: auth, body: { user: USER, product_code: 'nonexistent' } })
  check('unknown product → 404', badProduct.status === 404)
}

// ---------- 4. entitlement + consumable products ----------
console.log('\n▸ 4. One-time entitlement + consumable (ledger-backed) products')
{
  const ent = await call('/api/v1/checkout', { headers: auth, body: { user: USER, product_code: 'vip_theme_pack' } })
  const entDone = await call('/api/v1/checkout/complete', { headers: auth, body: { session_id: ent.json?.session_id } })
  check(
    'entitlement product grants permanent access',
    entDone.json?.status === 'completed' && entDone.json?.entitlement?.code === 'vip_themes' && entDone.json?.entitlement?.permanent === true,
  )

  const before = await call(`/api/v1/users/${USER}/state`, { headers: auth })
  const coinsBefore = before.json?.wallets?.find((w: any) => w.currency === 'coins')?.balance ?? 0
  const coin = await call('/api/v1/checkout', { headers: auth, body: { user: USER, product_code: 'coin_bag_small' } })
  const coinDone = await call('/api/v1/checkout/complete', { headers: auth, body: { session_id: coin.json?.session_id } })
  check('consumable checkout completes', coinDone.json?.status === 'completed' && coinDone.json?.currencyGrant?.amount === 500)

  const after = await call(`/api/v1/users/${USER}/state`, { headers: auth })
  const coinsAfter = after.json?.wallets?.find((w: any) => w.currency === 'coins')?.balance ?? 0
  check('consumable credited through the ledger (+500 coins)', coinsAfter === coinsBefore + 500, `${coinsBefore} → ${coinsAfter}`)
}

// ---------- 5. grant_entitlement engine action (§40 via rules) ----------
console.log('\n▸ 5. Engine action — grant_entitlement through the rule engine')
{
  const rule = await call('/api/admin/rules', {
    cookie: SID_COOKIE,
    body: {
      name: 'E2E loyalty badge rule', eventType: 'task.completed', priority: 40,
      conditionsJson: JSON.stringify({ op: 'and', conditions: [{ field: 'user.attribute.plan', operator: 'eq', value: 'free' }] }),
      actionsJson: JSON.stringify([{ type: 'grant_entitlement', params: { code: 'loyalty_badge', days: 30 } }]),
      status: 'active',
    },
  })
  check('rule with grant_entitlement action created', rule.status === 201)

  await fetch(`${BASE}/api/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ event_type: 'task.completed', external_user_id: 'grace', payload: { difficulty: 'easy', count: 1 } }),
  })
  const graceState = await call(`/api/v1/users/grace/state`, { headers: auth })
  const loyalty = graceState.json?.entitlements?.find((e: any) => e.code === 'loyalty_badge')
  check(
    'engine action granted time-boxed entitlement',
    loyalty?.status === 'active' && !!loyalty?.endsAt,
    `loyalty_badge expires ${loyalty?.endsAt?.slice(0, 10)}`,
  )
  // cleanup rule
  const rid = rule.json?.item?.id
  await call(`/api/admin/rules/${rid}`, { cookie: SID_COOKIE, method: 'PATCH', body: { status: 'draft' } })
  await call(`/api/admin/rules/${rid}`, { cookie: SID_COOKIE, method: 'DELETE' })
}

// ---------- 6. admin overview + reconcile + cancel (§202) ----------
console.log('\n▸ 6. Admin — overview, reconciliation, cancellation')
{
  const overview = await call('/api/admin/monetization', { cookie: SID_COOKIE })
  const s = overview.json?.summary
  check(
    'admin monetization overview with summary',
    overview.status === 200 && (s?.activeSubscriptions ?? 0) >= 1 && (s?.activeEntitlements ?? 0) >= 3 && (s?.completedCheckouts ?? 0) >= 3 && (s?.revenueEstimate ?? 0) > 0,
    `subs=${s?.activeSubscriptions}, ents=${s?.activeEntitlements}, checkouts=${s?.completedCheckouts}, revenue=$${s?.revenueEstimate?.toFixed(2)}`,
  )

  const recon = await call('/api/admin/monetization', { cookie: SID_COOKIE, body: { action: 'reconcile' } })
  check(
    'reconciliation runs: active sub re-asserts entitlement',
    recon.status === 200 && recon.json?.result?.activeSubscriptions >= 1,
    JSON.stringify(recon.json?.result),
  )

  const cancel = await call('/api/admin/monetization', {
    cookie: SID_COOKIE,
    body: { action: 'cancel_subscription', user: USER, product_code: 'focus_pro' },
  })
  check('subscription cancels at period end', cancel.json?.result?.cancelAtPeriodEnd === true)

  const state = await call(`/api/v1/users/${USER}/state`, { headers: auth })
  check('cancellation reflected in state', state.json?.subscriptions?.[0]?.cancelAtPeriodEnd === true)

  // audit trail for monetization events
  const audit = await call('/api/admin/audit/list?limit=30', { cookie: SID_COOKIE })
  const auditList = audit.json?.entries ?? []
  check(
    'checkout + reconcile audited',
    auditList.some((a: any) => String(a.action).includes('checkout')) && auditList.some((a: any) => String(a.action).includes('reconcile')),
  )
}

// ---------- 7. webhook delivery — signed, live, with retry (§99) ----------
console.log('\n▸ 7. Webhooks — live signed delivery + retry + redelivery')
{
  // register a live endpoint pointing at the local receiver
  const endpoint = await call('/api/admin/webhooks', {
    cookie: SID_COOKIE,
    body: { url: `http://localhost:${HOOK_PORT}/hooks`, secret: 'whsec_e2e_secret', eventsJson: JSON.stringify(['task.completed']) },
  })
  check('live webhook endpoint registered', endpoint.status === 201)

  hookLog.length = 0
  await fetch(`${BASE}/api/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ event_type: 'task.completed', external_user_id: USER, payload: { difficulty: 'easy', count: 1 } }),
  })
  await new Promise((r) => setTimeout(r, 900))

  check('webhook delivered to live receiver', hookLog.length >= 1, `${hookLog.length} deliveries`)
  if (hookLog.length > 0) {
    const d = hookLog[0]
    check('delivery carries event type + payload', d.headers['x-gog-event'] === 'task.completed' && d.body?.type === 'task.completed' && d.body?.data?.trace_id, `type=${d.body?.type}, trace=${String(d.body?.data?.trace_id).slice(0, 8)}…`)

    // HMAC signature verification (sha256 of "timestamp.body")
    const { createHmac } = await import('node:crypto')
    const ts = d.headers['x-gog-timestamp']
    const sig = d.headers['x-gog-signature']
    const expected = createHmac('sha256', 'whsec_e2e_secret').update(`${ts}.${JSON.stringify(d.body)}`).digest('hex')
    check('HMAC-SHA256 signature valid', sig === expected, sig ? `sig=${sig.slice(0, 16)}…` : 'no signature header')
  }

  // admin delivery log
  const log = await call('/api/admin/webhook-deliveries?limit=20', { cookie: SID_COOKIE })
  check(
    'admin webhook delivery log',
    log.status === 200 && (log.json?.summary?.delivered ?? 0) >= 1,
    `delivered=${log.json?.summary?.delivered}, retrying=${log.json?.summary?.retrying}, failed=${log.json?.summary?.failed}`,
  )

  // retry path: switch receiver to failing, trigger, verify retrying status
  hookMode = 'fail'
  hookLog.length = 0
  await fetch(`${BASE}/api/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ event_type: 'task.completed', external_user_id: USER, payload: { difficulty: 'easy', count: 1 } }),
  })
  await new Promise((r) => setTimeout(r, 700))
  const log2 = await call('/api/admin/webhook-deliveries?limit=20', { cookie: SID_COOKIE })
  const failedDelivery = (log2.json?.deliveries ?? []).find((d: any) => d.status === 'retrying' || d.status === 'failed')
  check('failed delivery enters retry state', !!failedDelivery, `status=${failedDelivery?.status}, attempts=${failedDelivery?.attempts}`)

  // manual redelivery with receiver healthy again
  hookMode = 'ok'
  if (failedDelivery) {
    const redeliver = await call('/api/admin/webhook-deliveries', { cookie: SID_COOKIE, body: { action: 'redeliver', delivery_id: failedDelivery.id } })
    check('manual redelivery succeeds when receiver recovers', redeliver.json?.result === 'delivered', `result=${redeliver.json?.result}`)
  }

  // cleanup endpoint
  const eid = endpoint.json?.item?.id
  await call(`/api/admin/webhooks/${eid}`, { cookie: SID_COOKIE, method: 'PATCH', body: { status: 'draft' } })
  await call(`/api/admin/webhooks/${eid}`, { cookie: SID_COOKIE, method: 'DELETE' })
}

// ---------- cleanup ----------
await call(`/api/admin/apikeys/list?id=${KEY_ID}`, { cookie: SID_COOKIE, method: 'DELETE' })
hookServer.stop(true)

console.log('\n════════════════════════════════════════════════════════════════')
console.log(`  RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(`  Failed: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('  🎉 ALL MONETIZATION + WEBHOOK + PERSONALIZATION CHECKS PASSED.')
process.exit(0)
