/**
 * GamificationOG — Rate Limiting (Next.js glue, § Advanced security)
 * Thin request-facing helpers over the pure limiter in limiter.ts.
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  consume,
  loginLockedFor,
  recordLoginFailure,
  clearLoginFailures,
  type RateLimitDecision,
} from './limiter'

export type { RateLimitDecision }

export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'local'
}

/**
 * Consume one request token for a v1 API caller.
 * Two tiers: pre-auth per-IP guard and post-auth per-key quota.
 */
export function consumeRateLimit(key: string): RateLimitDecision {
  return consume(key)
}

export function rateLimitedResponse(decision: RateLimitDecision): NextResponse {
  const res = NextResponse.json(
    {
      error: {
        code: 'RATE_LIMITED',
        category: 'rate_limit',
        message: 'Too many requests. Slow down and retry after the indicated delay.',
        retryAfterSeconds: decision.retryAfterSeconds,
      },
    },
    { status: 429 },
  )
  if (Number.isFinite(decision.limit)) {
    res.headers.set('x-ratelimit-limit', String(decision.limit))
    res.headers.set('x-ratelimit-remaining', String(decision.remaining))
  }
  res.headers.set('retry-after', String(decision.retryAfterSeconds))
  return res
}

export { loginLockedFor, recordLoginFailure, clearLoginFailures }
