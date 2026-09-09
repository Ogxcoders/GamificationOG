/**
 * GamificationOG — CLI (Section 85).
 * Operator companion for the platform: status, event tailing, rules,
 * formula evaluation, capability discovery, pack management, package
 * import/export, and event simulation.
 *
 * Auth:
 *   v1 endpoints     → --key / GOG_API_KEY   (API key with required scopes)
 *   admin endpoints  → --email/--password or GOG_EMAIL/GOG_PASSWORD (session)
 *
 * Usage:
 *   bun scripts/cli.ts <command> [args] [--base URL] [--key KEY] [--json]
 *   (package.json exposes this as `bun run gog …`)
 */
const BASE = process.env.GOG_BASE_URL ?? 'http://localhost:3000'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'
const args: string[] = []
const opts: Record<string, string> = {}

for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next
      i++
    } else {
      opts[key] = 'true'
    }
  } else {
    args.push(a)
  }
}

const base = opts.base ?? BASE
const apiKey = opts.key ?? process.env.GOG_API_KEY
const email = opts.email ?? process.env.GOG_EMAIL
const password = opts.password ?? process.env.GOG_PASSWORD
const wantJson = opts.json === 'true'

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let sid: string | null = null

async function adminLogin(): Promise<string> {
  if (sid) return sid
  if (!email || !password) {
    fail('Admin credentials required for this command.', 'Set --email/--password or GOG_EMAIL/GOG_PASSWORD (defaults: owner@focusquest.app / gamification123 in the sandbox).')
  }
  const res = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const setCookie = res.headers.get('set-cookie') ?? ''
  if (!res.ok || !setCookie.includes('gog_sid')) {
    fail(`Login failed (${res.status}).`, 'Check GOG_EMAIL/GOG_PASSWORD credentials.')
  }
  sid = setCookie.split(';')[0]
  return sid
}

async function call(path: string, init: { method?: string; body?: unknown; auth?: 'admin' | 'key' | 'none' } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.auth === 'key') {
    if (!apiKey) fail('API key required.', 'Set --key or GOG_API_KEY.')
    headers.authorization = `Bearer ${apiKey}`
  } else if (init.auth !== 'none') {
    headers.cookie = await adminLogin()
  }
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* non-json */
  }
  return { status: res.status, json }
}

function fail(message: string, hint?: string): never {
  console.error(`\n  ✗ ${message}`)
  if (hint) console.error(`    ${hint}\n`)
  process.exit(1)
}

function ok(message: string, hint?: string) {
  console.log(`  ✓ ${message}${hint ? ` — ${hint}` : ''}`)
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const AMBER = '\x1b[33m'
const RESET = '\x1b[0m'

function header(title: string) {
  console.log(`\n${BOLD}${title}${RESET}`)
}

function table(rows: Array<Array<string>>, columns: Array<{ label: string; width: number }>) {
  if (rows.length === 0) {
    console.log(`  ${DIM}(empty)${RESET}`)
    return
  }
  console.log('  ' + columns.map((c) => c.label.padEnd(c.width)).join(' '))
  console.log('  ' + columns.map((c) => '─'.repeat(Math.min(c.width, c.label.length + 2))).join(' '))
  for (const row of rows) {
    console.log(
      '  ' + row
        .map((cell, i) => {
          const fitted = truncate(cell, columns[i].width)
          const visible = fitted.replace(ANSI_RE, '')
          return fitted + ' '.repeat(Math.max(0, columns[i].width - visible.length))
        })
        .join(' '),
    )
  }
}

const ANSI_RE = /\x1b\[[0-9;]*m/g

function truncate(s: string, width: number): string {
  // ANSI-aware: measure visible length, never cut escape sequences in half
  const plain = s.replace(ANSI_RE, '')
  if (plain.length <= width) return s
  if (!plain) return s
  if (!s.includes('\x1b[')) return plain.slice(0, width - 1) + '…'
  const color = s.match(ANSI_RE)?.[0] ?? ''
  return color + plain.slice(0, width - 1) + '…' + RESET
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

function requireArg(index: number, name: string): string {
  const value = args[index]
  if (!value) fail(`Missing <${name}> argument.`)
  return value
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStatus() {
  const health = await call('/', { auth: 'none' })
  if (health.status !== 200) fail(`Platform unreachable at ${base} (${health.status}).`)
  const r = await call('/api/admin/analytics/summary')
  const d = r.json ?? {}
  if (wantJson) return printJson(d)
  header(`GamificationOG — ${base}`)
  ok('platform reachable')
  const scope = d.scope ?? {}
  console.log(`  ${DIM}scope:${RESET} ${scope.projectName ?? 'FocusQuest'} / ${scope.environmentName ?? 'development'}`)
  const counters: Array<[string, unknown]> = Object.entries(d.counters ?? {})
  if (counters.length > 0) {
    table(
      counters.map(([k, v]) => [String(k), String(v)]),
      [{ label: 'counter', width: 26 }, { label: 'value', width: 10 }],
    )
  }
  const totals = d.summary?.totals ?? {}
  const totalParts = Object.entries(totals).map(([k, v]) => `${k}=${v}`)
  if (totalParts.length > 0) {
    console.log(`  ${DIM}engine totals:${RESET} ${totalParts.join('  ')}`)
  }
}

async function cmdEvents() {
  const sub = args[0] ?? 'tail'
  if (sub !== 'tail') fail(`Unknown events subcommand "${sub}".`, 'Use: events tail [--limit N] [--type T]')
  const limit = opts.limit ?? '20'
  const params = new URLSearchParams({ limit })
  if (opts.type) params.set('type', opts.type)
  const r = await call(`/api/v1/events?${params}`, { auth: 'key' })
  if (r.status !== 200) fail(`Events feed failed (${r.status}).`, r.json?.error?.message)
  const d = r.json ?? {}
  if (wantJson) return printJson(d)
  const events: Array<Record<string, unknown>> = d.events ?? []
  header(`Recent events (${events.length})`)
  table(
    events.map((e) => [
      String(e.receivedAt ?? e.occurredAt ?? '').slice(0, 19).replace('T', ' '),
      String(e.eventType ?? e.type ?? ''),
      String(e.externalUserId ?? e.userId ?? e.user ?? ''),
      String(e.status ?? ''),
    ]),
    [
      { label: 'received', width: 20 },
      { label: 'type', width: 32 },
      { label: 'user', width: 22 },
      { label: 'status', width: 10 },
    ],
    )
  const typeCounts = Object.entries(d.typeCounts ?? {})
  if (typeCounts.length > 0) {
    console.log(`\n  ${DIM}by type:${RESET} ${typeCounts.map(([t, n]) => `${t}(${n})`).join(' ')}`)
  }
}

async function cmdRules() {
  const sub = args[0] ?? 'list'
  if (sub !== 'list') fail(`Unknown rules subcommand "${sub}".`, 'Use: rules list [--status S]')
  const params = new URLSearchParams()
  if (opts.status) params.set('status', opts.status)
  const qs = params.toString()
  const r = await call(`/api/v1/rules${qs ? `?${qs}` : ''}`, { auth: 'key' })
  if (r.status !== 200) fail(`Rules list failed (${r.status}).`, r.json?.error?.message)
  const d = r.json ?? {}
  if (wantJson) return printJson(d)
  const rules: Array<Record<string, unknown>> = d.rules ?? []
  header(`Rules (${rules.length}${opts.status ? `, status=${opts.status}` : ''})`)
  table(
    rules.map((rule) => [
      String(rule.name ?? ''),
      String(rule.when ?? rule.eventType ?? ''),
      String(rule.priority ?? ''),
      String(rule.status ?? ''),
    ]),
    [
      { label: 'name', width: 38 },
      { label: 'WHEN', width: 30 },
      { label: 'prio', width: 6 },
      { label: 'status', width: 10 },
    ],
  )
}

async function cmdFormulas() {
  const sub = args[0] ?? ''
  if (sub !== 'evaluate') fail('Use: formulas evaluate <expression>', 'Example: formulas evaluate "10 * user.level + 5"')
  const expression = args[1] ?? fail('Missing formula expression.') as never
  const r = await call('/api/v1/formulas/evaluate', { auth: 'key', body: { expr: expression, vars: { 'user.level': 3, 'user.xp': 250 } } })
  if (r.status !== 200) fail(`Evaluation failed (${r.status}).`, r.json?.error?.message)
  const d = r.json ?? {}
  if (wantJson) return printJson(d)
  header('Formula evaluation')
  ok(`${expression} = ${d.value}`, `user.level=3, user.xp=250 · ${d.evaluatedInMs}ms (${d.engine})`)
}

async function cmdCapabilities() {
  const r = await call('/api/v1/capabilities', { auth: 'key' })
  if (r.status !== 200) fail(`Capabilities failed (${r.status}).`, r.json?.error?.message)
  const d = r.json ?? {}
  if (wantJson) return printJson(d)
  const summary = d.summary ?? {}
  header('Capability registry')
  for (const [k, v] of Object.entries(summary)) {
    if (v !== null && typeof v === 'object') {
      const inner = Object.entries(v as Record<string, unknown>).map(([ik, iv]) => `${ik}=${iv}`).join('  ')
      console.log(`  ${BOLD}${k}${RESET}  ${inner}`)
    } else {
      console.log(`  ${GREEN}${String(v).padEnd(4)}${RESET} ${k}`)
    }
  }
  const actions: Array<Record<string, string>> = (d.registry ?? []).filter((c: Record<string, string>) => c.kind === 'action')
  if (actions.length > 0) {
    console.log(`\n  ${BOLD}Actions${RESET}`)
    table(
      actions.map((a) => [a.name, a.domain, truncate(a.description ?? '', 60)]),
      [
        { label: 'action', width: 28 },
        { label: 'domain', width: 16 },
        { label: 'description', width: 62 },
      ],
    )
  }
}

async function cmdPacks() {
  const sub = args[0] ?? 'list'
  if (sub === 'list') {
    const r = await call('/api/admin/packs')
    if (r.status !== 200) fail(`Pack list failed (${r.status}).`, r.json?.error?.message)
    const d = r.json ?? {}
    if (wantJson) return printJson(d)
    const packs: Array<Record<string, unknown>> = d.packs ?? []
    header(`Pack catalog (${packs.length})`)
    table(
      packs.map((p) => [
        String(p.name ?? ''),
        String(p.category ?? ''),
        String(p.version ?? ''),
        p.installedAt ? `${GREEN}installed${RESET}` : `${DIM}—${RESET}`,
      ]),
      [
        { label: 'pack', width: 24 },
        { label: 'category', width: 16 },
        { label: 'version', width: 9 },
        { label: 'state', width: 12 },
      ],
    )
    return
  }

  const slug = requireArg(1, 'slug')
  const action = sub
  if (!['preview', 'install', 'uninstall'].includes(action)) {
    fail(`Unknown packs subcommand "${sub}".`, 'Use: packs list | packs preview|install|uninstall <slug>')
  }
  const r = await call('/api/admin/packs', { body: { slug, action } })
  if (r.status >= 400) fail(`${action} failed (${r.status}).`, r.json?.error?.message)
  if (wantJson) return printJson(r.json)

  if (action === 'preview') {
    const p = r.json?.preview ?? {}
    header(`Pack preview — ${p.name} v${p.version}`)
    for (const o of p.objects ?? []) {
      const marker = o.status === 'conflict' ? `${AMBER}! conflict${RESET}` : `${GREEN}+ create ${RESET}`
      console.log(`  ${marker} ${o.resource.padEnd(14)} ${truncate(o.summary, 60)}`)
      if (o.conflictReason) console.log(`    ${AMBER}${o.conflictReason}${RESET}`)
    }
    console.log(`\n  ${p.conflicts > 0 ? `${AMBER}${p.conflicts} conflict(s) — install will be blocked${RESET}` : `${GREEN}clean — ready to install${RESET}`}`)
  } else if (action === 'install') {
    const res = r.json?.result ?? {}
    ok(`installed ${res.installed ?? 0} objects`)
    for (const c of res.created ?? []) console.log(`    ${GREEN}+${RESET} ${c.resource.padEnd(14)} ${c.name}`)
  } else {
    const res = r.json?.result ?? {}
    ok(`uninstalled (${res.removedClean ?? 0} removed cleanly, ${res.archived ?? 0} archived)`)
  }
}

async function cmdExport() {
  const r = await call('/api/admin/export')
  if (r.status !== 200) fail(`Export failed (${r.status}).`, r.json?.error?.message)
  const out = opts.out ?? `gamification-package-${new Date().toISOString().slice(0, 10)}.json`
  await Bun.write(out, JSON.stringify(r.json, null, 2))
  if (wantJson) return printJson({ written: out, manifest: r.json?.manifest })
  const counts = r.json?.manifest?.counts ?? {}
  const total = Object.values(counts).reduce((s: number, n) => s + Number(n), 0)
  ok(`package written to ${out}`, `${total} objects · ${Object.keys(counts).length} resource kinds`)
}

async function cmdImport() {
  const file = requireArg(0, 'file')
  const text = await Bun.file(file).text()
  let pkg: unknown
  try {
    pkg = JSON.parse(text)
  } catch {
    fail(`${file} is not valid JSON.`)
  }
  const mode = opts['dry-run'] === 'true' ? 'dry-run' : 'apply'
  const strategy = opts.strategy === 'overwrite' ? 'overwrite' : 'skip'
  const r = await call('/api/admin/import', { body: { package: pkg, mode, strategy } })
  if (r.status >= 400) fail(`Import failed (${r.status}).`, r.json?.error?.message)
  const result = (r.json?.preview ?? r.json?.result) ?? {}
  if (wantJson) return printJson(r.json)
  header(`Import ${mode === 'dry-run' ? 'preview' : 'applied'} (${strategy} strategy)`)
  const s = result.summary ?? {}
  console.log(`  ${GREEN}${s.create ?? 0} create${RESET} · ${AMBER}${s.overwrite ?? 0} overwrite${RESET} · ${s.skip ?? 0} skip · ${DIM}${s.identical ?? 0} identical${RESET}`)
  for (const o of result.objects ?? []) {
    if (o.action === 'identical') continue
    const marker = o.action === 'create' ? `${GREEN}+${RESET}` : o.action === 'overwrite' ? `${AMBER}~${RESET}` : `${DIM}·${RESET}`
    console.log(`  ${marker} ${o.resource.padEnd(14)} ${o.naturalKey}${o.reason ? ` ${DIM}(${truncate(o.reason, 50)})${RESET}` : ''}`)
  }
  for (const w of result.warnings ?? []) console.log(`  ${AMBER}!${RESET} ${w}`)
  if (mode === 'apply') ok('applied — transactional, audited')
}

async function cmdSimulate() {
  const eventType = requireArg(0, 'event-type')
  const user = requireArg(1, 'user')
  let payload: Record<string, unknown> = {}
  if (args[2]) {
    try {
      payload = JSON.parse(args[2])
    } catch {
      fail('Payload must be valid JSON.', 'Example: simulate task.completed user_1 \'{"difficulty":"hard","count":2}\'')
    }
  }
  // identify is idempotent — ensures the user resolves
  await call('/api/v1/identify', { auth: 'key', body: { external_id: user } })
  const r = await call('/api/v1/events', {
    auth: 'key',
    body: { event_type: eventType, external_user_id: user, payload },
  })
  if (r.status !== 200) fail(`Simulation failed (${r.status}).`, r.json?.error?.message)
  const d = r.json ?? {}
  if (wantJson) return printJson(d)
  header(`Event simulated — ${eventType}`)
  ok(`status=${d.status} trace=${d.traceId ?? '—'}`)
  const delta = d.stateDelta ?? {}
  const parts: string[] = []
  if (delta.xpAwarded) parts.push(`+${delta.xpAwarded} XP`)
  for (const lu of delta.levelUps ?? []) parts.push(`LEVEL UP → ${lu.level ?? lu.newLevel}`)
  for (const c of delta.currencyChanges ?? []) parts.push(`${c.amount > 0 ? '+' : ''}${c.amount} ${c.currency}`)
  for (const a of delta.achievementsUnlocked ?? []) parts.push(`🏆 ${a.code ?? a.name}`)
  for (const n of delta.notifications ? [] : []) parts.push('')
  if (delta.streak) parts.push(`streak ${delta.streak.key}: ${delta.streak.current} (best ${delta.streak.best})`)
  if (parts.length > 0) console.log(`  ${GREEN}${parts.join('  ·  ')}${RESET}`)
  else console.log(`  ${DIM}no state changes${RESET}`)
  const actions: Array<Record<string, unknown>> = d.actions ?? []
  if (actions.length > 0) {
    console.log(`\n  ${BOLD}actions${RESET}`)
    for (const a of actions) console.log(`   ${GREEN}✓${RESET} ${String(a.action ?? '')} — ${truncate(String(a.detail ?? ''), 70)}`)
  }
}

async function cmdPromote() {
  const from = opts.from ?? requireArg(0, 'from-environment')
  const to = opts.to ?? requireArg(1, 'to-environment')
  const dryRun = opts['dry-run'] === 'true'
  const r = await call('/api/admin/promote', {
    auth: 'admin',
    body: { from, to, dryRun: dryRun !== false },
  })
  if (r.status !== 200 && r.status !== 201) fail(`Promotion failed (${r.status}).`, r.json?.error?.message)
  const result = r.json ?? {}
  if (wantJson) return printJson(result)
  header(`Environment promotion — ${from} → ${to}${dryRun ? ' (dry-run)' : ''}`)
  const s = result.summary ?? {}
  console.log(
    `  ${GREEN}${s.create ?? 0} create${RESET} · ${AMBER}${s.overwrite ?? 0} overwrite${RESET} · ${s.skip ?? 0} skip · ${DIM}${s.identical ?? 0} identical${RESET}`,
  )
  for (const o of result.objects ?? []) {
    if (o.action === 'identical') continue
    const marker = o.action === 'create' ? `${GREEN}+${RESET}` : o.action === 'overwrite' ? `${AMBER}~${RESET}` : `${DIM}·${RESET}`
    console.log(`  ${marker} ${o.resource.padEnd(14)} ${o.naturalKey}${o.reason ? ` ${DIM}(${truncate(o.reason, 50)})${RESET}` : ''}`)
  }
  if (!dryRun) ok(`promoted — transactional, audited (${result.applied ? 'applied' : 'not applied'})`)
  else console.log(`  ${DIM}dry-run only — re-run without --dry-run to apply${RESET}`)
}

function cmdHelp() {
  console.log(`
${BOLD}GamificationOG CLI${RESET} — operator companion (§85)

${BOLD}Usage:${RESET} bun scripts/cli.ts <command> [args] [options]     (alias: bun run gog)

${BOLD}Commands:${RESET}
  status                              platform health, scope, object counts
  events tail [--limit N] [--type T]  recent event stream (v1, events:read)
  rules list [--status S]             rules surface (v1, rules:read)
  formulas evaluate <expr>            sandboxed formula evaluation (formulas:eval)
  capabilities                        capability registry (registry:read)
  packs list                          pack catalog + install state
  packs preview|install|uninstall <slug>
  export [--out FILE]                 gamification system package (§59)
  import <FILE> [--dry-run] [--strategy skip|overwrite]
  promote --from development --to production [--dry-run]
                                     environment promotion via export→import(overwrite)
  simulate <type> <user> [JSON]       ingest an event, show state delta (events:write)

${BOLD}Options:${RESET}
  --base URL        API base (default GOG_BASE_URL or http://localhost:3000)
  --key KEY         API key for v1 endpoints (or GOG_API_KEY)
  --email E --password P   admin session (or GOG_EMAIL/GOG_PASSWORD)
  --json            raw JSON output
`)
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const commands: Record<string, () => Promise<void> | void> = {
  help: cmdHelp,
  status: cmdStatus,
  events: cmdEvents,
  rules: cmdRules,
  formulas: cmdFormulas,
  capabilities: cmdCapabilities,
  packs: cmdPacks,
  export: cmdExport,
  import: cmdImport,
  promote: cmdPromote,
  simulate: cmdSimulate,
}

const fn = commands[command]
if (!fn) {
  cmdHelp()
  fail(`Unknown command "${command}".`)
}
await fn()
