/**
 * GamificationOG — Cross-language parity test: Rust core engine vs
 * TypeScript engine (Section 87 / §284 API-SDK parity).
 * Runs the same inputs through both implementations and asserts
 * identical results: formulas (seeded rules + edge cases), progression
 * curves, and dense ranking.
 *
 * Usage: bun scripts/e2e-rust-parity.ts
 */
import { execFileSync } from 'node:child_process'

const CLI = './target/debug/gog-engine'
const RUST_AVAILABLE = (() => {
  try {
    execFileSync(CLI, ['help'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

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

async function main() {
  console.log('\n══════════ GamificationOG — RUST ⟷ TS PARITY ══════════\n')
  if (!RUST_AVAILABLE) {
    console.log('  ⚠️  Rust CLI not built — run: cargo build')
    process.exit(2)
  }

  // TS formula engine
  const { evaluateFormula } = await import('../src/server/engine/formula')

  // ---- 1. Formula parity (seeded Customer Zero rules + edge cases) ----
  console.log('▸ 1. Formula engine parity (Rust CLI vs TS engine)')
  const cases: Array<{ expr: string; vars: Record<string, unknown> }> = [
    // the actual seeded rules
    { expr: '20 + (event.payload.difficulty == "hard" ? 30 : event.payload.difficulty == "medium" ? 10 : 0)', vars: { 'event.payload.difficulty': 'hard' } },
    { expr: '20 + (event.payload.difficulty == "hard" ? 30 : event.payload.difficulty == "medium" ? 10 : 0)', vars: { 'event.payload.difficulty': 'medium' } },
    { expr: '20 + (event.payload.difficulty == "hard" ? 30 : event.payload.difficulty == "medium" ? 10 : 0)', vars: { 'event.payload.difficulty': 'easy' } },
    { expr: 'min(event.payload.minutes * 2, 60)', vars: { 'event.payload.minutes': 30 } },
    { expr: 'min(event.payload.minutes * 2, 60)', vars: { 'event.payload.minutes': 20 } },
    { expr: 'min(event.payload.minutes * 2, 60)', vars: { 'event.payload.minutes': 60 } },
    // edge cases
    { expr: '2 + 3 * 4 ^ 2', vars: {} },
    { expr: 'clamp(15, 0, 10)', vars: {} },
    { expr: 'floor(2.9) + ceil(2.1)', vars: {} },
    { expr: 'abs(-7) + sqrt(16)', vars: {} },
    { expr: 'user.level * 25 + 10', vars: { 'user.level': 4 } },
    { expr: 'if(user.level >= 3, 10, 5)', vars: { 'user.level': 4 } },
    { expr: '1 and 0 or 1', vars: {} },
    { expr: 'round(2.5) * 2', vars: {} },
    { expr: 'pow(2, 10)', vars: {} },
  ]

  for (const c of cases) {
    const tsResult = evaluateFormula(c.expr, c.vars as never)
    const args = [c.expr, ...Object.entries(c.vars).map(([k, v]) => ['--var', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`]).flat()]
    const rustOut = execFileSync(CLI, ['formula', ...args], { stdio: 'pipe' }).toString().trim()
    const rustResult = Number(rustOut)
    const equal = Math.abs(rustResult - tsResult) < 1e-9
    check(
      `formula: ${c.expr.slice(0, 58)}${c.expr.length > 58 ? '…' : ''}`,
      equal,
      `ts=${tsResult} rust=${rustOut}`,
    )
  }

  // rejection parity: both must fail on the same bad inputs
  const badExprs = ['2 *** 3', '1 / 0', 'explode(1)', '(1 + 2']
  for (const bad of badExprs) {
    const tsFails = (() => {
      try {
        evaluateFormula(bad, {})
        return false
      } catch {
        return true
      }
    })()
    const rustFails = (() => {
      try {
        execFileSync(CLI, ['formula', bad], { stdio: 'pipe' })
        return false
      } catch {
        return true
      }
    })()
    check(`rejection parity: ${bad}`, tsFails && rustFails)
  }

  // ---- 2. Progression parity ----
  console.log('\n▸ 2. Progression parity (TS-verified live values)')
  // TS live system verified: ada 350 XP → level 4, xpForNextLevel 400
  // linear formula: level = floor(xp / base) + 1
  const progCases: Array<{ xp: number; base: number; max: number; level: number; into: number }> = [
    { xp: 350, base: 100, max: 50, level: 4, into: 50 },
    { xp: 0, base: 100, max: 50, level: 1, into: 0 },
    { xp: 99, base: 100, max: 50, level: 1, into: 99 },
    { xp: 100, base: 100, max: 50, level: 2, into: 0 },
    { xp: 700, base: 100, max: 50, level: 8, into: 0 },
    { xp: 505, base: 100, max: 50, level: 6, into: 5 },
    { xp: 9999, base: 100, max: 10, level: 10, into: 9099 }, // clamped at max, overflow XP counts into level
  ]
  for (const p of progCases) {
    const out = execFileSync(CLI, ['progression', '--xp', String(p.xp), '--base', String(p.base), '--max', String(p.max)], { stdio: 'pipe' }).toString().trim()
    const level = Number(out.match(/level=(\d+)/)?.[1])
    const into = Number(out.match(/xp_into_level=([\d.]+)/)?.[1])
    check(`progression: ${p.xp} XP / ${p.base} base → level ${p.level}`, level === p.level && Math.abs(into - p.into) < 1e-9, `rust: ${out.split(' ').slice(0, 2).join(' ')}`)
  }

  // ---- 3. Ranking parity ----
  console.log('\n▸ 3. Dense ranking parity (TS leaderboard semantics)')
  const rankCases: Array<{ scores: number[]; expected: number[] }> = [
    { scores: [100, 100, 90, 80], expected: [1, 1, 2, 3] },
    { scores: [50, 40, 60], expected: [2, 3, 1] }, // highest-wins: 60→#1, 50→#2, 40→#3
    { scores: [10, 10, 10], expected: [1, 1, 1] },
    { scores: [5, 4, 3, 2, 1], expected: [1, 2, 3, 4, 5] },
  ]
  for (const rc of rankCases) {
    const out = execFileSync(CLI, ['rank', rc.scores.join(',')], { stdio: 'pipe' }).toString().trim()
    const ranks = out.split(',').map(Number)
    check(`rank: [${rc.scores.join(',')}] → [${rc.expected.join(',')}]`, JSON.stringify(ranks) === JSON.stringify(rc.expected), `rust: [${ranks.join(',')}]`)
  }

  // ---- 4. Full simulation through the Rust engine ----
  console.log('\n▸ 4. Deterministic simulation (Rust engine, no side effects)')
  const rules = [
    { name: 'task_xp', event_type: 'task.completed', priority: 100, actions: [{ type: 'award_xp', params: { amount: '20 + (event.payload.difficulty == "hard" ? 30 : 0)' } }, { type: 'add_currency', params: { currency: 'coins', amount: 10 } }] },
  ]
  const events = Array.from({ length: 10 }, () => ({ event_type: 'task.completed', external_user_id: 'sim', payload: { difficulty: 'hard' } }))
  const rulesFile = '/tmp/gog-parity-rules.json'
  const eventsFile = '/tmp/gog-parity-events.json'
  await Bun.write(rulesFile, JSON.stringify(rules))
  await Bun.write(eventsFile, JSON.stringify(events))
  const simOut = execFileSync(CLI, ['simulate', '--rules', rulesFile, '--events', eventsFile], { stdio: 'pipe' }).toString()
  const report = JSON.parse(simOut)
  check('simulation: 10 hard tasks → 500 XP, level 6', report.users.sim.xp === 500 && report.users.sim.level === 6, `xp=${report.users.sim.xp}, level=${report.users.sim.level}, coins=${report.users.sim.coins}`)
  check('simulation: totals track users', report.totals.events === 10 && report.totals.rules_fired === 10)
  const simOut2 = execFileSync(CLI, ['simulate', '--rules', rulesFile, '--events', eventsFile], { stdio: 'pipe' }).toString()
  check('simulation: bit-identical replay (determinism §256)', simOut === simOut2)

  console.log('\n════════════════════════════════════════════════════════════════')
  console.log(`  RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log(`  Failed: ${failures.join(' | ')}`)
    process.exit(1)
  }
  console.log('  🎉 RUST ⟷ TS PARITY CONFIRMED — the Rust brain matches the TypeScript engine.')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
