/**
 * GamificationOG — MCP control-plane surface E2E (Sections 65, 153, 154).
 *
 * Verifies the public v1 API endpoints that back the MCP tools
 * (Go server in services/mcp-server): rules read, events feed, formula
 * evaluation, capability registry — plus scope enforcement so AI agents
 * are permission-scoped, never privileged by default.
 *
 * Usage: bun scripts/e2e-mcp.ts [base-url]
 */
const BASE = process.argv[2] ?? 'http://localhost:3000'
const ts = Date.now()

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

async function call(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* non-json */
  }
  return { status: res.status, json }
}

async function main() {
  console.log('\n══════════ GamificationOG — MCP CONTROL-PLANE SURFACE E2E ══════════\n')

  // ---------- setup: admin session + MCP-scoped API key ----------
  const login = await fetch(`${BASE}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@focusquest.app', password: 'gamification123' }),
  })
  if (login.status !== 200) {
    console.log(`FATAL: admin login failed (${login.status}) — is the server running and seeded?`)
    process.exit(1)
  }
  const SID_COOKIE = (login.headers.get('set-cookie') ?? '').split(';')[0]

  const MCP_SCOPES = ['rules:read', 'rules:propose', 'events:read', 'events:write', 'state:read', 'formulas:eval', 'registry:read']
  const keyRes = await call('/api/admin/apikeys/list', {
    headers: { cookie: SID_COOKIE },
    body: { name: `E2E MCP key ${ts}`, scopes: MCP_SCOPES },
  })
  const KEY = keyRes.json?.key?.key ?? ''
  const KEY_ID = keyRes.json?.key?.id ?? ''
  const auth = { authorization: `Bearer ${KEY}` }
  check('setup: MCP-scoped API key created', KEY.startsWith('gog_'))

  // restricted key — only events:write (scope isolation, Section 153)
  const weakRes = await call('/api/admin/apikeys/list', {
    headers: { cookie: SID_COOKIE },
    body: { name: `E2E MCP restricted ${ts}`, scopes: ['events:write'] },
  })
  const WEAK_KEY = weakRes.json?.key?.key ?? ''
  const WEAK_ID = weakRes.json?.key?.id ?? ''
  const weakAuth = { authorization: `Bearer ${WEAK_KEY}` }

  const USER = `mcp_agent_${ts}`

  // ---------- 1. list_rules (GET /api/v1/rules) ----------
  console.log('▸ 1. Rules surface (list_rules tool backing)')
  {
    const res = await call('/api/v1/rules', { headers: auth })
    check('GET /api/v1/rules → 200', res.status === 200)
    const rules: any[] = res.json?.rules ?? []
    check('seeded rules returned', rules.length >= 4, `${rules.length} rules`)
    const focus = rules.find((r) => r.name === 'Focus session → XP by minutes')
    check('rule shape: when/if/then/priority', !!focus && focus.when === 'focus.session.completed' && Array.isArray(focus.then) && typeof focus.priority === 'number', focus ? `when=${focus.when}` : 'not found')

    const filtered = await call('/api/v1/rules?status=active&type=focus.session.completed', { headers: auth })
    const fr: any[] = filtered.json?.rules ?? []
    check('filters: status + type narrow results', filtered.status === 200 && fr.length >= 1 && fr.every((r) => r.when === 'focus.session.completed'))
  }

  // ---------- 2. events feed (GET /api/v1/events) ----------
  console.log('\n▸ 2. Events feed (list_events tool backing)')
  {
    // produce a real event through the pipeline first
    await call('/api/v1/identify', { headers: auth, body: { external_id: USER, display_name: 'MCP Agent' } })
    await call('/api/v1/events', {
      headers: auth,
      body: { event_type: 'task.completed', external_user_id: USER, payload: { difficulty: 'hard' } },
    })

    const res = await call('/api/v1/events?limit=5', { headers: auth })
    check('GET /api/v1/events → 200', res.status === 200)
    const events: any[] = res.json?.events ?? []
    check('feed returns recent events', events.length >= 1, `${events.length} events`)
    const mine = events.find((e) => e.type === 'task.completed' && e.user === 'MCP Agent')
    check('tracked event visible with status + payload', !!mine && !!mine.status && mine.payload?.difficulty === 'hard', mine ? `status=${mine.status}` : 'not found')
    check('feed includes trace id linkage', events.some((e) => e.traceId), 'decision traces are reachable')
    const counts: any[] = res.json?.typeCounts ?? []
    check('type counts computed', counts.length >= 1 && counts.some((c) => c.type === 'task.completed'))
  }

  // ---------- 3. formula evaluation (POST /api/v1/formulas/evaluate) ----------
  console.log('\n▸ 3. Formula evaluation (evaluate_formula tool backing)')
  {
    const res = await call('/api/v1/formulas/evaluate', {
      headers: auth,
      body: { expr: '20 + (event.payload.difficulty == "hard" ? 30 : 0)', vars: { 'event.payload.difficulty': 'hard' } },
    })
    check('seeded rule formula → 50', res.status === 200 && res.json?.value === 50, `value=${res.json?.value}`)

    const res2 = await call('/api/v1/formulas/evaluate', {
      headers: auth,
      body: { expr: 'min(event.payload.minutes * 2, 60)', vars: { 'event.payload.minutes': 45 } },
    })
    check('min() formula → 60 (clamped)', res2.status === 200 && res2.json?.value === 60)

    const res3 = await call('/api/v1/formulas/evaluate', {
      headers: auth,
      body: { expr: 'clamp(15, 0, 10) + pow(2, 5)' },
    })
    check('multi-function formula → 42', res3.status === 200 && res3.json?.value === 42, `value=${res3.json?.value}`)

    const bad = await call('/api/v1/formulas/evaluate', { headers: auth, body: { expr: 'explode(1)' } })
    check('invalid formula → structured FORMULA_INVALID error', bad.status === 400 && bad.json?.error?.code === 'FORMULA_INVALID', `status=${bad.status}, code=${bad.json?.error?.code}`)

    const noExpr = await call('/api/v1/formulas/evaluate', { headers: auth, body: {} })
    check('missing expr → FIELD_REQUIRED', noExpr.status === 400 && noExpr.json?.error?.code === 'FIELD_REQUIRED')
  }

  // ---------- 4. capability registry (GET /api/v1/capabilities) ----------
  console.log('\n▸ 4. Capability registry (list_capabilities tool backing)')
  {
    const res = await call('/api/v1/capabilities', { headers: auth })
    check('GET /api/v1/capabilities → 200', res.status === 200)
    const registry: any[] = res.json?.registry ?? []
    const kinds = new Set(registry.map((c) => c.kind))
    check('registry covers extension points', kinds.has('action') && kinds.has('condition_operator') && kinds.has('formula_function'), [...kinds].join(', '))
    const summary = res.json?.summary ?? {}
    check('summary counts present', Object.keys(summary).length >= 3, `${Object.keys(summary).length} summary keys`)
  }

  // ---------- 5. scope enforcement (Section 153: permission-scoped) ----------
  console.log('\n▸ 5. Scope enforcement — restricted key (events:write only)')
  {
    const cases = [
      { path: '/api/v1/rules', code: 'SCOPE_MISSING' },
      { path: '/api/v1/events', code: 'SCOPE_MISSING' },
      { path: '/api/v1/capabilities', code: 'SCOPE_MISSING' },
    ]
    for (const c of cases) {
      const res = await call(c.path, { headers: weakAuth })
      check(`restricted key blocked: ${c.path}`, res.status === 401 && res.json?.error?.code === c.code)
    }
    const res = await call('/api/v1/formulas/evaluate', { headers: weakAuth, body: { expr: '1+1' } })
    check('restricted key blocked: formula eval', res.status === 401 && res.json?.error?.code === 'SCOPE_MISSING')

    // events:write still allowed for the restricted key
    const ok = await call('/api/v1/events', {
      headers: weakAuth,
      body: { event_type: 'task.completed', external_user_id: USER, payload: { difficulty: 'easy' } },
    })
    check('restricted key still writes events (least-privilege works)', ok.status === 200, `status=${ok.status}`)
  }

  // ---------- 6. auth required (no key at all) ----------
  console.log('\n▸ 6. No authentication → rejected')
  {
    for (const p of ['/api/v1/rules', '/api/v1/events', '/api/v1/capabilities', '/api/v1/proposals']) {
      const res = await call(p)
      check(`no key rejected: ${p}`, res.status === 401 && res.json?.error?.code === 'API_KEY_REQUIRED')
    }
  }

  // ---------- 7. AI proposals (§66-67: write-tools behind human approval) ----------
  console.log('\n▸ 7. AI proposals — propose → human approves → rule created (§66-67)')
  {
    // AI proposes a rule (validated at submission)
    const propose = await call('/api/v1/proposals', {
      headers: auth,
      body: {
        type: 'rule.create',
        payload: {
          name: `AI Proposal Rule ${ts}`,
          description: 'Proposed by the e2e MCP agent',
          eventType: 'ai.proposed.event',
          conditionsJson: { op: 'and', conditions: [{ field: 'event.payload.difficulty', operator: 'eq', value: 'hard' }] },
          actionsJson: [{ type: 'award_xp', params: { amount: 33 } }],
          priority: 400,
          status: 'draft',
        },
        rationale: 'E2E: verifying the proposal → approval → execution pipeline (§66 AI operating flow).',
      },
    })
    check('AI submits proposal (201 pending)', propose.status === 201 && propose.json?.status === 'pending', `id=${propose.json?.id?.slice(0, 10)}`)
    const proposalId = propose.json?.id

    // invalid proposal rejected at submission
    const invalid = await call('/api/v1/proposals', {
      headers: auth,
      body: { type: 'rule.create', payload: { name: 'Bad', eventType: 'NOT VALID', actionsJson: '[]' } },
    })
    check('invalid proposal rejected at submission (400)', invalid.status === 400, `code=${invalid.json?.error?.code}`)

    // unsupported proposal type
    const unsupported = await call('/api/v1/proposals', {
      headers: auth,
      body: { type: 'user.delete', payload: {} },
    })
    check('unsupported proposal type rejected', unsupported.status === 400 && unsupported.json?.error?.code === 'PROPOSAL_TYPE_UNSUPPORTED')

    // rules:read is NOT enough to propose (least privilege)
    const readKey = await call('/api/admin/apikeys/list', {
      headers: { cookie: SID_COOKIE },
      body: { name: `E2E read-only ${ts}`, scopes: ['rules:read'] },
    })
    const readKeySecret = readKey.json?.key?.key
    const proposeDenied = await call('/api/v1/proposals', {
      headers: { authorization: `Bearer ${readKeySecret}` },
      body: { type: 'rule.create', payload: { name: 'x', eventType: 'x.y', actionsJson: '[]' } },
    })
    check('rules:read key cannot propose (scope enforcement)', proposeDenied.status === 401, `status=${proposeDenied.status}`)
    check('rules:read key CAN list proposals (read access)', (await call('/api/v1/proposals', { headers: { authorization: `Bearer ${readKeySecret}` } })).status === 200)

    // AI tracks its proposals
    const track = await call('/api/v1/proposals?status=pending', { headers: auth })
    check('AI lists pending proposals', track.status === 200 && (track.json?.proposals ?? []).some((p: any) => p.id === proposalId))
    check('supported types advertised', Array.isArray(track.json?.supportedTypes) && track.json.supportedTypes.includes('rule.create'))

    // nothing created yet — write-tools NEVER write directly
    const rulesBefore = await call('/api/admin/rules?limit=500', { headers: { cookie: SID_COOKIE } })
    const existsBefore = (rulesBefore.json?.items ?? []).some((r: any) => r.name === `AI Proposal Rule ${ts}`)
    check('no rule exists before approval (AI cannot write directly)', !existsBefore)

    // AI keys can NEVER decide — only human admin sessions
    const aiDecide = await call(`/api/admin/proposals/${proposalId}/decide`, {
      headers: auth,
      body: { decision: 'approve' },
    })
    check('AI key cannot approve (admin-only route)', aiDecide.status === 401, `status=${aiDecide.status}`)

    // human rejects a decoy first
    const decoy = await call('/api/v1/proposals', {
      headers: auth,
      body: { type: 'rule.create', payload: { name: `AI Decoy ${ts}`, eventType: 'ai.decoy.event', actionsJson: '[{"type":"award_xp","params":{"amount":1}}]' }, rationale: 'decoy' },
    })
    const reject = await call(`/api/admin/proposals/${decoy.json?.id}/decide`, {
      headers: { cookie: SID_COOKIE },
      body: { decision: 'reject', note: 'not aligned' },
    })
    check('human rejects proposal (no side effects)', reject.status === 200 && reject.json?.result?.status === 'rejected')
    const doubleReject = await call(`/api/admin/proposals/${decoy.json?.id}/decide`, {
      headers: { cookie: SID_COOKIE },
      body: { decision: 'approve' },
    })
    check('double-decide rejected (409)', doubleReject.status === 409, `status=${doubleReject.status}`)

    // human approves the real proposal
    const approve = await call(`/api/admin/proposals/${proposalId}/decide`, {
      headers: { cookie: SID_COOKIE },
      body: { decision: 'approve', note: 'e2e approved' },
    })
    check('human approves → executed', approve.status === 200 && approve.json?.result?.status === 'approved', `createdId=${approve.json?.result?.createdId?.slice(0, 10)}`)

    // the rule now exists with AI provenance
    const rulesAfter = await call('/api/admin/rules?limit=500', { headers: { cookie: SID_COOKIE } })
    const createdRule = (rulesAfter.json?.items ?? []).find((r: any) => r.name === `AI Proposal Rule ${ts}`)
    check('rule created after approval with provenance metadata', Boolean(createdRule) && String(createdRule.metadataJson ?? '').includes('"proposedByAi":true'))
    check('created rule status preserved (draft)', createdRule?.status === 'draft')

    // audit trail: human approved + ai created
    const audit = await call('/api/admin/audit/list?limit=30', { headers: { cookie: SID_COOKIE } })
    const entries = audit.json?.entries ?? []
    check('audit: proposal.approved (human actor)', entries.some((e: any) => e.action === 'proposal.approved' && e.actorType === 'human'))
    check('audit: rule.created (ai actor)', entries.some((e: any) => e.action === 'rule.created' && e.actorType === 'ai'))

    // cleanup: delete the created rule (draft → hard delete) + revoke read key
    if (createdRule) {
      await call(`/api/admin/rules/${createdRule.id}`, { headers: { cookie: SID_COOKIE }, method: 'DELETE' })
    }
    await call(`/api/admin/apikeys/list?id=${readKey.json?.key?.id}`, { headers: { cookie: SID_COOKIE }, method: 'DELETE' })
  }

  // ---------- cleanup ----------
  await call(`/api/admin/apikeys/list?id=${KEY_ID}`, { headers: { cookie: SID_COOKIE }, method: 'DELETE' })
  await call(`/api/admin/apikeys/list?id=${WEAK_ID}`, { headers: { cookie: SID_COOKIE }, method: 'DELETE' })

  console.log('\n════════════════════════════════════════════════════════════════')
  console.log(`  RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log(`  Failed: ${failures.join(' | ')}`)
    process.exit(1)
  }
  console.log('  🎉 MCP CONTROL-PLANE SURFACE VERIFIED — permission-scoped AI tool endpoints live.')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
