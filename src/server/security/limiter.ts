/**
 * GamificationOG — Rate Limit core (pure, framework-free)
 * Token-bucket limiter + login attempt throttling.
 *
 * Framework glue lives in rate-limit.ts; this module is importable from
 * plain scripts (CLI / e2e tests) without a Next.js runtime.
 */

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  retryAfterSeconds: number
}

interface Bucket {
  tokens: number
  lastRefill: number // epoch ms
}

const buckets = new Map<string, Bucket>()
const MAX_KEYS = 50_000
let lastSweep = Date.now()

function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000 && buckets.size < MAX_KEYS) return
  lastSweep = now
  for (const [k, b] of buckets) {
    if (now - b.lastRefill > windowMs * 3) buckets.delete(k)
  }
}

export interface RateLimitConfig {
  max: number
  windowMs: number
}

/**
 * Resolve the active config. Production defaults are conservative;
 * development defaults are generous so local test runs never trip.
 * Explicit env always wins (GOG_RATE_LIMIT_MAX / GOG_RATE_LIMIT_WINDOW).
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig & { enabled: boolean } {
  const explicit = Number(env.GOG_RATE_LIMIT_MAX)
  const isProd = env.NODE_ENV === 'production'
  const max = Number.isFinite(explicit) && env.GOG_RATE_LIMIT_MAX !== undefined
    ? explicit
    : isProd
      ? 600
      : 5000
  const windowSec = Math.max(1, Number(env.GOG_RATE_LIMIT_WINDOW ?? 60))
  return { max, windowMs: windowSec * 1000, enabled: max > 0 }
}

/** Consume one token for `key`. */
export function consume(key: string, override?: RateLimitConfig): RateLimitDecision {
  const cfg = resolveConfig()
  const limit = override?.max ?? cfg.max
  const window = override?.windowMs ?? cfg.windowMs
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, limit: Infinity, remaining: Infinity, retryAfterSeconds: 0 }
  }
  const now = Date.now()
  sweep(now, window)
  const bucket = buckets.get(key) ?? { tokens: limit, lastRefill: now }
  const elapsed = now - bucket.lastRefill
  const refill = (elapsed / window) * limit
  bucket.tokens = Math.min(limit, bucket.tokens + refill)
  bucket.lastRefill = now
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    buckets.set(key, bucket)
    return { allowed: true, limit, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 }
  }
  const needed = 1 - bucket.tokens
  const retryMs = (needed / limit) * window
  buckets.set(key, bucket)
  return {
    allowed: false,
    limit,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
  }
}

/** Test/ops helper: reset limiter state (this process only). */
export function resetLimiter() {
  buckets.clear()
}

// ---------------------------------------------------------------------------
// Login attempt throttling (stricter, always active in every environment)
// ---------------------------------------------------------------------------

const loginFailures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>()

export interface LoginPolicy {
  maxFailures: number
  windowMs: number
  lockMs: number
}

export function loginPolicy(env: NodeJS.ProcessEnv = process.env): LoginPolicy {
  return {
    maxFailures: Math.max(1, Number(env.GOG_LOGIN_MAX_FAILURES ?? 10)),
    windowMs: Math.max(1, Number(env.GOG_LOGIN_WINDOW_MINUTES ?? 15)) * 60_000,
    lockMs: Math.max(1, Number(env.GOG_LOGIN_LOCK_MINUTES ?? 15)) * 60_000,
  }
}

/** Seconds remaining in lockout for this principal; 0 = not locked. */
export function loginLockedFor(key: string, policy?: LoginPolicy): number {
  const p = policy ?? loginPolicy()
  const rec = loginFailures.get(key)
  if (!rec) return 0
  if (rec.lockedUntil > Date.now()) return Math.ceil((rec.lockedUntil - Date.now()) / 1000)
  // expire stale records
  if (Date.now() - rec.firstAt > p.windowMs * 2) loginFailures.delete(key)
  return 0
}

export function recordLoginFailure(key: string, policy?: LoginPolicy) {
  const p = policy ?? loginPolicy()
  const now = Date.now()
  const rec = loginFailures.get(key)
  if (!rec || now - rec.firstAt > p.windowMs) {
    loginFailures.set(key, { count: 1, firstAt: now, lockedUntil: 0 })
    return
  }
  rec.count += 1
  if (rec.count >= p.maxFailures) rec.lockedUntil = now + p.lockMs
  loginFailures.set(key, rec)
}

export function clearLoginFailures(key: string) {
  loginFailures.delete(key)
}

export function resetLoginTracker() {
  loginFailures.clear()
}
