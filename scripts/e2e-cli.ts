/**
 * GamificationOG — CLI E2E (Section 85).
 * Runs scripts/cli.ts as a child process for every command and asserts
 * output + exit codes: status, events, rules, formulas, capabilities,
 * packs (list/preview/install/uninstall), export, import, simulate,
 * auth guards, and JSON mode.
 *
 * Usage: bun scripts/e2e-cli.ts [baseUrl]
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

const ADMIN = {
  GOG_EMAIL: 'owner@focusquest.app',
  GOG_PASSWORD: 'gamification123',
  GOG_BASE_URL: BASE,
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.GOG_EMAIL, password: ADMIN.GOG_PASSWORD }),
  })
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

async function createKey(sid: string): Promise<{ id: string; key: string }> {
  const res = await fetch(`${BASE}/api/admin/apikeys/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sid },
    body: JSON.stringify({ name: 'E2E CLI key', scopes: ['events:read', 'events:write', 'rules:read', 'formulas:eval', 'registry:read'] }),
  })
  const json = (await res.json()) as { key: { id: string; key: string } }
  return json.key
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'scripts/cli.ts', ...args, '--base', BASE], {
    cwd: '/home/z/my-project',
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { code, stdout, stderr }
}

console.log('\n══════════ GamificationOG — CLI E2E (§85) ══════════\n')

const SID = await login()
const KEY = await createKey(SID)
const KEYENV = { GOG_API_KEY: KEY.key, ...ADMIN }

// ============================
// 1. Help + status
// ============================
console.log('▸ 1. Help, status')
{
  const help = await cli(['help'])
  check('help lists commands', help.code === 0 && /packs|simulate|export/.test(help.stdout))

  const unknown = await cli(['frobnicate'], ADMIN)
  check('unknown command exits non-zero with hint', unknown.code !== 0 && /Unknown command/.test(unknown.stderr + unknown.stdout))

  const status = await cli(['status'], ADMIN)
  check('status reaches platform and prints scope', status.code === 0 && /platform reachable/.test(status.stdout) && /FocusQuest/.test(status.stdout))
  check('status shows counters + engine totals', /totalUsers|totalEvents/.test(status.stdout) && /actions_executed/.test(status.stdout))

  const noAuth = await cli(['status'], { GOG_BASE_URL: BASE })
  check('status without credentials fails cleanly (exit 1, hint)', noAuth.code === 1 && /credentials required/i.test(noAuth.stderr))

  const unreachable = await cli(['status'], { GOG_BASE_URL: 'http://localhost:9' })
  check('unreachable platform exits non-zero', unreachable.code === 1)
}

// ============================
// 2. v1 commands (API key)
// ============================
console.log('\n▸ 2. v1 commands (API-key auth)')
{
  const events = await cli(['events', 'tail', '--limit', '5'], KEYENV)
  check('events tail lists recent events', events.code === 0 && /Recent events/.test(events.stdout) && /task\.completed|app\.opened|xp\.awarded/.test(events.stdout))

  const rules = await cli(['rules', 'list'], KEYENV)
  check('rules list shows rules with WHEN column', rules.code === 0 && /Complete task/.test(rules.stdout) && /task\.completed/.test(rules.stdout))

  const filtered = await cli(['rules', 'list', '--status', 'draft'], KEYENV)
  check('rules list --status filter accepted', filtered.code === 0)

  const formula = await cli(['formulas', 'evaluate', '10 * user.level + 5'], KEYENV)
  check('formulas evaluate computes 35', formula.code === 0 && /10 \* user\.level \+ 5 = 35/.test(formula.stdout))

  const badFormula = await cli(['formulas', 'evaluate', '2 +* 3'], KEYENV)
  check('invalid formula surfaces structured error (exit 1)', badFormula.code === 1 && /Evaluation failed/.test(badFormula.stderr))

  const caps = await cli(['capabilities'], KEYENV)
  check('capabilities prints registry summary + actions', caps.code === 0 && /award_xp/.test(caps.stdout) && /Capability registry/.test(caps.stdout))

  const noKey = await cli(['rules', 'list'], ADMIN)
  check('v1 command without API key fails cleanly', noKey.code === 1 && /API key required/.test(noKey.stderr))
}

// ============================
// 3. Simulate — full engine loop through the CLI
// ============================
console.log('\n▸ 3. Simulate (engine loop)')
{
  const user = `cli_user_${Date.now().toString(36).slice(-4)}`
  const sim = await cli(['simulate', 'task.completed', user, '{"difficulty":"hard","count":2}'], KEYENV)
  check('simulate processes event', sim.code === 0 && /status=processed/.test(sim.stdout))
  check('simulate shows state delta', /\+50 XP/.test(sim.stdout) && /first_task|streak/.test(sim.stdout))
  check('simulate lists executed actions', /award_xp/.test(sim.stdout) && /add_currency/.test(sim.stdout))

  const sim2 = await cli(['simulate', 'task.completed', user, 'not-json'], KEYENV)
  check('simulate rejects invalid JSON payload (exit 1)', sim2.code === 1 && /valid JSON/.test(sim2.stderr))
}

// ============================
// 4. Packs through the CLI
// ============================
console.log('\n▸ 4. Pack management')
{
  const list = await cli(['packs', 'list'], ADMIN)
  check('packs list shows 8 packs', list.code === 0 && /Pack catalog \(8\)/.test(list.stdout) && /Daily Streak/.test(list.stdout))

  const preview = await cli(['packs', 'preview', 'daily-streak'], ADMIN)
  check('packs preview shows plan', preview.code === 0 && /Pack preview — Daily Streak/.test(preview.stdout) && /ready to install/.test(preview.stdout))

  const install = await cli(['packs', 'install', 'daily-streak'], ADMIN)
  check('packs install creates 4 objects', install.code === 0 && /installed 4 objects/.test(install.stdout))

  const installed = await cli(['packs', 'list'], ADMIN)
  check('pack state flips to installed', /Daily Streak\s+streaks\s+1\.0\.0.*installed/.test(installed.stdout))

  await new Promise((r) => setTimeout(r, 1500))
  const uninstall = await cli(['packs', 'uninstall', 'daily-streak'], ADMIN)
  check('packs uninstall removes cleanly', uninstall.code === 0 && /uninstalled \(4 removed cleanly, 0 archived\)/.test(uninstall.stdout))

  const missing = await cli(['packs', 'install', 'no-such-pack'], ADMIN)
  check('unknown pack fails with message', missing.code === 1 && /PACK_NOT_FOUND|does not exist/.test(missing.stderr))
}

// ============================
// 5. Export / import through the CLI
// ============================
console.log('\n▸ 5. Export / import')
{
  const out = '/tmp/cli-e2e-export.json'
  const exp = await cli(['export', '--out', out], ADMIN)
  check('export writes package file', exp.code === 0 && /package written/.test(exp.stdout) && await Bun.file(out).exists())

  const pkg = await Bun.file(out).json()
  check('exported file is a valid package', pkg?.manifest?.kind === 'gamificationog.gamification-system')

  const dry = await cli(['import', out, '--dry-run'], ADMIN)
  check('import --dry-run previews (all identical)', dry.code === 0 && /Import preview/.test(dry.stdout) && /identical/.test(dry.stdout))

  const apply = await cli(['import', out], ADMIN)
  check('import apply is idempotent (0 changes)', apply.code === 0 && /applied — transactional, audited/.test(apply.stdout))

  const bad = await cli(['import', '/nonexistent.json'], ADMIN)
  check('import missing file fails cleanly', bad.code === 1)
}

// ============================
// 6. JSON mode + cleanup
// ============================
console.log('\n▸ 6. JSON mode + cleanup')
{
  const json = await cli(['rules', 'list', '--json'], KEYENV)
  let parsed: any = null
  try {
    parsed = JSON.parse(json.stdout)
  } catch {
    /* invalid */
  }
  check('rules list --json emits parseable JSON', json.code === 0 && Array.isArray(parsed?.rules) && parsed.rules.length > 0)

  // revoke key
  const res = await fetch(`${BASE}/api/admin/apikeys/list?id=${KEY.id}`, { method: 'DELETE', headers: { cookie: SID } })
  const revoked = (await res.json()) as { revoked?: boolean }
  check('cleanup: CLI key revoked', revoked.revoked === true)
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
console.log('  🎉 CLI VERIFIED — all commands, auth modes, guards, and JSON output green.')
process.exit(0)
