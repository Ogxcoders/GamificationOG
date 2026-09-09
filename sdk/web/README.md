# @gamificationog/sdk

Official TypeScript / web SDK for **GamificationOG** — the universal, configuration-first, event-driven engagement platform.

## Install

```bash
bun add @gamificationog/sdk
# or: npm i @gamificationog/sdk
```

## Quick start

```ts
import { GamificationOG } from '@gamificationog/sdk'

const gog = new GamificationOG({
  apiKey: 'gog_your_key_here',       // from Settings → API keys
  baseUrl: 'https://your-deployment', // optional, defaults to current origin
})

// 1. identify the user (anonymous ids supported)
await gog.identify('user_123', {
  displayName: 'Ada',
  attributes: { plan: 'free' },
})

// 2. track events — the full engine runs server-side
const result = await gog.track('task.completed', { difficulty: 'hard' })

console.log(result.stateDelta.xpAwarded)      // 50
console.log(result.stateDelta.levelUps)       // [{ track, from, to }]
console.log(result.stateDelta.achievementsUnlocked)
console.log(result.traceId)                   // full decision trace

// 3. read state for your UI
const state = await gog.getUserState()
const board = await gog.getLeaderboard('weekly_focus_minutes', 50)
const flags = await gog.getFlags()
```

## Anonymous → identified merge

```ts
// start anonymous
const anonId = GamificationOG.anonymousId()
await gog.identify(anonId, { anonymous: true })

// ... user logs in later — progress is preserved via identity merge
await gog.identify('real_user_id', {
  mergeFromExternalId: anonId,
  attributes: { email: 'ada@example.com' },
})
```

## Offline resilience

Failed `track()` calls are queued in `localStorage` and batch-flushed
automatically (default every 10s, or when 50 events are pending). Use
`trackSafe()` for fire-and-forget tracking that never throws.

```ts
gog.trackSafe('page.viewed', { path: '/dashboard' }) // never throws
await gog.flush()                                     // manual flush
gog.queueSize                                          // queued count
```

## Error contract

All errors carry structured metadata (`code`, `fix`, `traceId`) matching the
platform's error experience spec:

```ts
try {
  await gog.track('task.completed', {})
} catch (e: any) {
  console.log(e.code)    // e.g. SCHEMA_VALIDATION_FAILED
  console.log(e.fix)     // human-readable fix suggestion
  console.log(e.traceId) // support trace id
}
```

## API surface

| Method | Description |
|--------|-------------|
| `identify(id, traits?)` | Create/resolve a user, optional anonymous merge |
| `track(type, payload?, opts?)` | Fire an event through the full engine |
| `trackSafe(...)` | Fire-and-forget with offline queue |
| `getUserState(id?)` | Progression, wallets, inventory, achievements, challenges, streaks |
| `getLeaderboard(code, limit?, around?)` | Ranking view with "around me" |
| `getFlags(id?)` | Feature flags, experiment variants, remote config, segments |
| `flush()` | Manually flush the offline queue |
| `GamificationOG.anonymousId()` | Persisted anonymous id |

## License

MIT
