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
| **Rule engine** | Declarative WHEN/IF/THEN, priority ordering, cooldowns, frequency caps, segment targeting, schedules, 17 comparison operators with nested and/or/not trees |
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
| **Analytics** | Daily aggregate read models, rebuildable from raw events |
| **Observability** | **Decision traces** — every pipeline step recorded with inputs/outputs/durations; immutable audit log with actor types (human/system/plugin/ai); structured actionable errors |
| **Admin dashboard** | 16 areas: overview, events feed + schema registry, rules, challenges, achievements, streaks, rewards, economy + ledger, inventory, leaderboards, segments, experiments/flags/config, users explorer, analytics, traces viewer, audit log, playground simulator, settings/API keys, capability registry |
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

The seed creates a complete reference product — **FocusQuest**, a productivity app — using only platform primitives: 8 event schemas, 3 currencies, 3 items, 6 rewards, 6 rules, 4 challenges, 6 achievements, streaks with milestones, 3 leaderboards, 3 segments, an experiment, flags, remote config, a season, and 3 demo users.

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
| `GET /api/v1/users/{externalId}/state` | Complete state snapshot |
| `GET /api/v1/leaderboards?code=` | Ranking view + around-me |
| `GET /api/v1/flags?user=` | Flags, experiment variants, remote config, segments |

Admin API (`/api/admin/*`): session auth + generic validated CRUD for 17 resource types, events feed + replay, playground simulation, traces, audit, analytics, economy integrity + rebuild, API key management, capability registry, scope switching.

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
│   │   ├── analytics/ tracing(via traces) audit/ registry/
│   │   └── admin/              # resource registry (generic CRUD + validation)
│   ├── app/                    # dashboard pages + API routes
│   ├── components/dashboard/   # shell, generic resource CRUD
│   └── lib/                    # api helpers, auth, client api
├── sdk/web/                    # TypeScript web SDK (offline queue)
└── scripts/seed.ts             # Customer Zero reference seed
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
- 🔜 Phase 4 — visual UI builder, packs, plugins, import/export, CLI, MCP/AI control plane
- 🔜 Phase 5 — SSO, SCIM, multi-region, enterprise hardening

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
