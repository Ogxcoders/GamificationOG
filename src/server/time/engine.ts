/**
 * GamificationOG — Time Engine (Section 18)
 * Time is a first-class reusable system. All timestamps stored in UTC.
 * Provides calendar boundaries, rolling/fixed windows, cadence buckets,
 * cooldowns, grace periods — nothing hardcodes "daily" in domain features.
 */

export type Cadence = 'daily' | 'weekly' | 'monthly' | 'all_time'
export type TimeWindow = 'all_time' | 'daily' | 'weekly' | 'monthly' | 'seasonal'

/** Canonical UTC date key: YYYY-MM-DD */
export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Week key: YYYY-Www (ISO week, Monday start) */
export function weekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = date.getUTCDay() || 7 // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

/** Month key: YYYY-MM */
export function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7)
}

/**
 * Period bucket for a given cadence. Used by challenges (resets),
 * leaderboards (time windows) and frequency caps.
 */
export function periodKeyFor(cadence: Cadence | TimeWindow, at: Date): string {
  switch (cadence) {
    case 'daily': return dateKey(at)
    case 'weekly': return weekKey(at)
    case 'monthly': return monthKey(at)
    case 'all_time':
    case 'seasonal': return 'all'
    default: return 'all'
  }
}

/** Start of the UTC day containing `at` */
export function startOfDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
}

/** Start of the ISO week (Monday) containing `at` */
export function startOfWeek(at: Date): Date {
  const d = startOfDay(at)
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - (dayNum - 1))
  return d
}

/** Start of the UTC month containing `at` */
export function startOfMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
}

/** Boundary (start) for a window; null for all_time */
export function windowStart(window: TimeWindow, at: Date): Date | null {
  switch (window) {
    case 'daily': return startOfDay(at)
    case 'weekly': return startOfWeek(at)
    case 'monthly': return startOfMonth(at)
    default: return null
  }
}

/**
 * Streak gap evaluation — the heart of the streak system (Section 24).
 * Returns whether a new qualifying event continues a streak, breaks it,
 * or is a duplicate within the current period.
 */
export type StreakEvaluation = 'continue' | 'break' | 'same_period' | 'first'

export function evaluateStreakGap(
  cadence: Cadence,
  lastQualifyingAt: Date | null,
  now: Date,
  gracePeriodHours = 0,
): StreakEvaluation {
  if (!lastQualifyingAt) return 'first'

  const currentPeriod = periodKeyFor(cadence === 'all_time' ? 'daily' : cadence, now)
  const lastPeriod = periodKeyFor(cadence === 'all_time' ? 'daily' : cadence, lastQualifyingAt)
  if (currentPeriod === lastPeriod) return 'same_period'

  // previous period expected for continuation
  const expectedPrev = previousPeriodKey(cadence === 'all_time' ? 'daily' : cadence, now)
  if (lastPeriod === expectedPrev) return 'continue'

  // grace period: allow late qualification within N hours after period boundary
  if (gracePeriodHours > 0) {
    const boundary = windowStart(cadence === 'daily' ? 'daily' : cadence === 'weekly' ? 'weekly' : 'monthly', now)
    if (boundary) {
      const boundaryPlusGrace = boundary.getTime() + gracePeriodHours * 3600000
      if (now.getTime() <= boundaryPlusGrace && lastPeriod === previousPeriodKeyOfKey(cadence, currentPeriod)) {
        return 'continue'
      }
    }
  }
  return 'break'
}

function previousPeriodKey(cadence: Cadence, at: Date): string {
  switch (cadence) {
    case 'daily': return dateKey(new Date(at.getTime() - 86400000))
    case 'weekly': return weekKey(new Date(at.getTime() - 7 * 86400000))
    case 'monthly': {
      const d = new Date(at)
      d.setUTCMonth(d.getUTCMonth() - 1)
      return monthKey(d)
    }
    default: return 'all'
  }
}

function previousPeriodKeyOfKey(cadence: Cadence, currentKey: string): string {
  // approximate: for grace evaluation only
  switch (cadence) {
    case 'daily': return dateKey(new Date(new Date(currentKey + 'T00:00:00Z').getTime() - 86400000))
    case 'weekly': return currentKey
    default: return currentKey
  }
}

/** Cooldown check: has enough time passed since `lastAt`? */
export function cooldownPassed(lastAt: Date | null, cooldownSeconds: number, now: Date): boolean {
  if (!lastAt) return true
  return now.getTime() - lastAt.getTime() >= cooldownSeconds * 1000
}

/** Effective date window check for rules */
export function withinWindow(now: Date, from: Date | null | undefined, to: Date | null | undefined): boolean {
  if (from && now < from) return false
  if (to && now > to) return false
  return true
}

/** Deterministic bucket assignment (used by experiments + flag rollout) */
export function deterministicBucket(seed: string, buckets = 100): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % buckets
}
