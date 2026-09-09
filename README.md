# GamificationOG 🎮

**A programmable, event-driven engagement operating system** — stable universal primitives form the core, configuration defines product behavior, and every engine decision is inspectable.

Built from the [UNIVERSAL GAMIFICATION PLATFORM MASTER PLAN](/UNIVERSAL_GAMIFICATION_PLATFORM_MASTER_PLAN-3.md) — a universal, configuration-first engagement infrastructure that can power gamification in **any** app, game, SaaS, education, fitness, loyalty, marketplace or social product. The difference between a productivity app and an RPG is *configuration*, not a different engine.

---

## What this is

```
ANY APP / WEBSITE / GAME
        ↓
Events ──→ Event Gateway ──→ Schema Validation ──→ Idempotency
        ↓
Context Engine (user, progression, economy, segments, flags, time)
        ↓
Rules (WHEN event / IF conditions / THEN actions)
        ↓
Action Engine (award XP, credit currency, grant items, unlock achievements...)
        ↓
Processors (challenges, streaks, leaderboards, achievements)
        ↓
Decision Trace + Analytics + Audit
        ↓
SDK / API
```

The universal feedback loop — **EVENT → CONTEXT → CONDITION → DECISION → ACTION → STATE CHANGE → EVENT** — is the backbone of everything.

## Implemented capabilities

| Domain | What's included |
|---|---|
| **Tenancy** | Organization → Workspace → Project → Environment (dev/staging/prod) isolation |
| **Identity** | Anonymous + named users, identify, anonymous→known **identity merge with progress preservation**, sessions, API keys with scopes |
| **Event system** | Gateway with schema registry + payload validation, idempotency keys, batch ingestion, replay/reprocess, correlation/causation chains |
| **Context engine** | Full evaluation context: user, event, progression, wallets, inventory, segments, flags, experiment variants, time |
| **Rule engine** | Declarative WHEN/IF/THEN, priority ordering, cooldowns, frequency caps, segment targeting, schedules, 17 comparison operators with nested and/or/not trees, **visual rule builder** (structured condition tree + typed action params with Visual ⇄ JSON toggle) |
| **Formula engine** | Safe deterministic expression evaluator (no `eval`): arithmetic, ternary, `min/max/floor/ceil/round/abs/clamp/sqrt/pow/if`, formula-powered reward amounts |
| **Action engine** | 13 registered actions (award_xp, add/spend_currency, grant_item, grant_reward, unlock_achievement, update_challenge_progress, update_streak, update_leaderboard, send_notification, set_user_attribute, set_user_variable, emit_event) with validation + idempotency + per-action error isolation |
| **Progression** | Multi-track XP→level: linear, exponential, or custom formula |
| **Challenges** | Daily/weekly/monthly/one-time/timed/seasonal; event_count, event_sum, unique_entities metric sources; period resets via Time Engine |
| **Achievements** | One-time, repeatable, hidden, progressive (progressField/progressTarget) with reward hooks |
| **Streaks** | Configurable cadence (daily/weekly/custom), grace periods, freeze counts, milestone rewards, reward multipliers |
| **Economy** | **Ledger-first**: immutable transactions are the source of truth; wallet balances are rebuildable projections; caps; integrity verification (sum(ledger) == sum(projections)) |
| **Inventory** | Consumables/durables/cosmetics with stacking, max stack, expiry |
| **Leaderboards** | event/xp/count metrics, all-time/daily/weekly/monthly windows, highest/lowest algorithms, deterministic dense ranks with tie-breaking |
| **Segments** | Dynamic condition-tree cohorts, reused by rules + flags |
| **Experiments & Flags** | Sticky deterministic bucketing, traffic gates, variant weights, rollout percentages, remote config |
| **Notifications** | In-app channel, `{{variable}}` template interpolation, anti-spam rate limits |
| **Observability** | **Decision traces** — every pipeline step recorded with inputs/outputs/durations; immutable audit log with actor types (human/system/plugin/ai); structured actionable errors |
| **AI / MCP control plane** | Permission-scoped AI tool endpoints (rules/events/formulas/capabilities), Go MCP server (JSON-RPC 2.0, stdio + HTTP) + API gateway with rate limiting and circuit breaking, Rust core-engine with **bit-identical parity** to the TS engine |
| **Pack system** | 8 built-in game-design bundles (daily-streak, productivity, learning, community, referral, competition, loyalty, RPG): preview with conflict detection, transactional install with lineage metadata, rollback-safe uninstall (pristine removed, user-modified archived) |
| **Import / export** | Portable gamification-system packages (manifest + 11 resource kinds, natural-keyed): dry-run diff (create/overwrite/skip/identical), skip/overwrite strategies, transactional apply, full round-trip fidelity |
| **CLI** | Operator companion (`bun run gog`): status, events tail, rules, formulas evaluate, capabilities, packs management, export/import, simulate — dual auth (API key / admin session), JSON mode |
| **AI proposals** | MCP write-tools behind human approval (§66-67): agents propose validated changes (rules:propose scope), humans approve/reject in the dashboard; execution goes through the validated create path with dual audit lineage (proposal.approved + resource.created by `ai` actor) |
| **Anti-cheat / risk engine** | Universal risk analysis on every live event (§74): velocity (per-minute/hour), impossible-speed, duplicate-payload farming, numeric value anomalies (leaderboard manipulation), multi-account signals → 0-100 score → **allow / throttle / hold / reject**; held events wait in a human review queue (release fires side effects exactly once, reject never); fail-open by design; per-environment config + settings UI card + risk metrics |
| **Recovery / replay** | Projection rebuild from stored events (§102): validate → reset per-user state → side-effect-isolated replay (no webhooks/metrics/traces; rule-executions re-recorded at original event times so caps reproduce) → before/after drift report → dry-run rollback vs apply promote; admin API + run history |
| **Realtime (SSE)** | Live stream over Server-Sent Events (§78): API-key auth (header or EventSource `?key=`), project/env-scoped topic subscriptions with prefix + wildcard, monotonic seq ordering, Last-Event-ID reconnect replay from a bounded ring, 15s heartbeats, bounded-queue backpressure; `event.processed` + `leaderboard:<name>` fan-out on live ingestion only; SDK `stream()` helper |
| **Disaster recovery** | Verified backup/restore (§101): online `VACUUM INTO` snapshot + integrity check + sha256/row-count manifest + retention pruning; restore modes (verify-only / `--target` drill / `--confirm` live swap with safety copy); tamper + corruption detection; RPO/RTO runbooks + scheduled drill cron (docs/DISASTER_RECOVERY.md) |
| **Analytics** | Daily aggregate read models, rebuildable from raw events |
| **Admin dashboard** | 18 areas: overview, events feed + schema registry, rules (visual builder), packs, AI proposals, challenges, achievements, streaks, rewards, economy + ledger, inventory, leaderboards, segments, experiments/flags/config, users explorer, analytics, traces viewer, audit log, playground simulator, settings/API keys + import/export, capability registry |
| **Web SDK** | Zero-dependency TypeScript SDK with offline queue + batch flush + anonymous merge |
| **Capability registry** | First-class discovery of all extension points (object types, events, actions, operators, formula functions) |

## Tech stack

- **Next.js 16** (App Router, Turbopack) + **TypeScript** (strict)
- **Prisma ORM** + SQLite (swap to PostgreSQL via `DATABASE_URL` for production)
- **Tailwind CSS 4** + shadcn/ui (New York) + Lucide icons
- Modular monolith: logical domain boundaries in `src/server/*` (per Master Plan §88 — physical separation only when operationally justified)

## Quick start

```bash
# 1. install
bun install

# 2. database
bun run db:push        # create schema
bun run seed           # Customer Zero demo project (FocusQuest)

# 3. run
bun run dev            # http://localhost:3000

# Dashboard login (from seed):
#   owner@focusquest.app / gamification123   ← change immediately
```

The seed creates a complete reference product — **FocusQuest**, a productivity app — using only platform primitives: 8 event schemas, 3 currencies, 3 items, 6 rewards, 6 rules, 4 challenges, 6 achievements, streaks with milestones, 3 leaderboards, 3 segments, an experiment, flags, remote config, a season, 3 demo users, and the 8-pack catalog.

Operate from the terminal:

```bash
bun run gog status                          # health + counters + engine totals
bun run gog simulate task.completed u1 '{"difficulty":"hard"}'   # full engine loop
bun run gog packs preview daily-streak      # what a pack would create
GOG_API_KEY=gog_... bun run gog rules list   # v1 surface (scope-checked)
```

## The golden path (Customer Zero)

```
Create account → log in → Playground → identify user → track event →
see state change (XP, level, coins, achievements, streak) →
open decision trace → inspect every rule evaluation → repeat
```

Try it: **Playground → pick `task.completed` with `{"difficulty":"hard"}` → Track event as "ada"** — you'll see the XP formula (hard = +30 bonus), the hard-task item drop at level ≥ 3, the daily challenge progressing, the streak updating, and the leaderboard rank — all in one trace.

## SDK integration

```ts
import { GamificationOG } from '@gamificationog/sdk' // see sdk/web

const gog = new GamificationOG({ apiKey: 'gog_...' })
await gog.identify('user_123', { plan: 'free' })

const result = await gog.track('task.completed', { difficulty: 'hard' })
result.stateDelta.xpAwarded          // 50
result.stateDelta.achievementsUnlocked
result.traceId                       // full decision trace

const state = await gog.getUserState()      // progression, wallets, challenges...
const board = await gog.getLeaderboard('weekly_focus_minutes')
```

Raw HTTP (any language):

```bash
curl -X POST $BASE_URL/api/v1/events \
  -H "Authorization: Bearer gog_..." \
  -H "Content-Type: application/json" \
  -d '{"event_type":"task.completed","external_user_id":"user_123","payload":{"difficulty":"hard"}}'
```

## Public API (v1)

| Endpoint | Description |
|---|---|
| `POST /api/v1/identify` | Identify/create user, anonymous merge |
| `POST /api/v1/events` | Track event (single or `{events:[...]}` batch) — full pipeline runs synchronously |
| `GET /api/v1/events` | Recent event feed + type counts (scope `events:read`) — MCP `list_events` backing |
| `GET /api/v1/rules` | Rule configuration, WHEN/IF/THEN shape (scope `rules:read`) — MCP `list_rules` backing |
| `POST /api/v1/formulas/evaluate` | Dry-run a formula through the sandboxed engine (scope `formulas:eval`) — MCP `evaluate_formula` backing |
| `GET /api/v1/capabilities` | Capability registry discovery (scope `registry:read`) — MCP `list_capabilities` backing |
| `GET /api/v1/users/{externalId}/state` | Complete state snapshot |
| `GET /api/v1/leaderboards?code=` | Ranking view + around-me |
| `GET /api/v1/flags?user=` | Flags, experiment variants, remote config, segments |
| `POST /api/v1/proposals` | AI proposal: validated config change awaiting human approval (scope `rules:propose`) — MCP `propose_rule` backing |
| `GET /api/v1/proposals` | Proposal status tracking for agents (scope `rules:propose` or `rules:read`) — MCP `list_proposals` backing |

Admin API (`/api/admin/*`): session auth + generic validated CRUD for 17 resource types, events feed + replay, playground simulation, traces, audit, analytics, economy integrity + rebuild, API key management, capability registry, scope switching, pack install/uninstall, package import/export, proposal approval queue.

## Repository layout

```
├── prisma/schema.prisma        # 40+ domain models (Master Plan §5 primitives)
├── src/
│   ├── server/                 # Domain modules (logical boundaries)
│   │   ├── core/               # types, structured errors, object contract
│   │   ├── tenancy/            # org > workspace > project > environment
│   │   ├── identity/           # users, merge, sessions, API keys, admin auth
│   │   ├── events/             # gateway: validate → dedupe → process pipeline
│   │   ├── engine/             # context, conditions, formulas, rules, actions
│   │   ├── time/               # time engine: cadences, windows, streaks
│   │   ├── progression/ challenges/ achievements/ streaks/ rewards/
│   │   ├── economy/            # ledger-first + wallet projections
│   │   ├── inventory/ leaderboards/ segments/ experiments/ notifications/
│   │   ├── packs/              # pack catalog + install lifecycle (§57)
│   │   ├── io/                # package exporter/importer (§59-60)
│   │   ├── proposals/         # AI proposal service (§66-67)
│   │   ├── analytics/ tracing(via traces) audit/ registry/
│   │   └── admin/              # resource registry (generic CRUD + validation)
│   ├── app/                    # dashboard pages + API routes
│   ├── components/dashboard/   # shell, generic resource CRUD
│   ├── components/rules/       # visual rule builder
│   ├── components/settings/    # import/export card
│   └── lib/                    # api helpers, auth, client api, rule catalog
├── sdk/web/                    # TypeScript web SDK (offline queue)
├── crates/                     # Rust core engine (gog-engine CLI): formulas, progression, ranking, rules, simulation — parity-tested against the TS engine
├── services/gateway/           # Go API gateway: rate limiting, circuit breaker, correlation ids
├── services/mcp-server/        # Go MCP server (JSON-RPC 2.0): AI agent tools over the v1 API
├── backups/                   # §101 snapshots (gitignored)
├── docs/DISASTER_RECOVERY.md  # RPO/RTO + backup/restore runbooks
└── scripts/                    # seed, cli.ts (bun run gog), backup/restore, 21 e2e suites (bash scripts/run-all-tests.sh)
```

## Architectural invariants (enforced)

- **Tenant isolation** — every query scoped by project + environment
- **Ledger-first economy** — balances are projections; `verify` + `rebuild` endpoints
- **Idempotency** — event keys, action keys, reward grant keys (retries never double-post)
- **Auditability** — admin mutations recorded with before/after; active objects archive instead of hard delete
- **Deterministic engine** — same input + config → same outcome (ranking, rewards, progression)
- **Decision traces** — every event's full pipeline recorded step-by-step
- **Configuration-first** — behavior lives in validated config objects, never hardcoded product logic

## Roadmap (per Master Plan phases)

- ✅ Phase 1 — vertical slice: events → rules → actions → state → traces → UI → SDK
- ✅ Phase 2 — challenges, achievements, streaks, progression, economy, inventory, leaderboards, analytics, notifications
- ✅ Phase 3 (core) — segments, experiments, feature flags, remote config
- ✅ Phase 4 — **complete**: MCP/AI control plane (scoped tool endpoints + Go MCP server + gateway), Rust core-engine parity, monetization, **visual rule builder, pack system, import/export, CLI, AI proposals with human approval**
- ✅ Phase 5 — **complete**: SSO (OIDC + PKCE + JIT), SCIM 2.0 provisioning, logical regions/data residency, plugins + marketplace, security hardening (rate limiting, login lockout, security headers), observability (health + Prometheus metrics), environment promotion
- ✅ Phase 6 — **complete (production hardening)**: anti-cheat risk engine (§74), event replay/projection rebuild (§102), realtime SSE (§78), disaster recovery (§101) — **full platform E2E: 21 suites, 849 checks, all green**

## AI / MCP integration

AI agents operate the platform through **permission-scoped domain tools** (Master Plan §65/§153) — never raw database access:

```jsonc
// services/mcp-server — JSON-RPC 2.0 over stdio or HTTP
{ "method": "tools/call", "params": { "name": "list_rules", "arguments": {} } }
{ "method": "tools/call", "params": { "name": "evaluate_formula", "arguments": { "expr": "20 + (user.level * 5)" } } }
```

Tools: `list_rules`, `get_user_state`, `simulate_event`, `list_events`, `evaluate_formula`, `leaderboard`, `list_capabilities`, `propose_rule`, `list_proposals` — each maps to a scope-checked v1 API call, so agents inherit the platform's auth, audit and idempotency guarantees.

**Write-tools behind approval (§66-67):** `propose_rule` submits a validated configuration change as a *pending proposal* (scope `rules:propose`) — the AI never writes directly. Humans review the queue in **Dashboard → AI Proposals** (payload + rationale + decision notes) and approve/reject; approval executes through the same validated create path used by manual configuration, producing dual audit lineage: `proposal.approved` (human actor) and `rule.created` (ai actor).

The Rust core engine (`crates/`, `cargo build` → `./target/debug/gog-engine`) provides the same formula/progression/ranking semantics as the TypeScript engine — verified by the parity suite (`bun scripts/e2e-rust-parity.ts`, 33 checks incl. bit-identical simulation replay).

## Deploying on your server

```bash
git clone https://github.com/Ogxcoders/GamificationOG.git
cd GamificationOG && bun install
cp .env.example .env   # set DATABASE_URL (PostgreSQL for production)
bun run db:push && bun run seed
bun run build && bun run start   # or bun run dev
```

Security notes: change the seeded owner password immediately, rotate the demo API key, and put the app behind TLS before production use.

## License

MIT
