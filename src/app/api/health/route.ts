/**
 * GET /api/health — liveness + readiness probe (public; no auth).
 * 200 when all checks pass, 503 when degraded (DB down, engine broken).
 * Load balancers / Kubernetes / Docker healthchecks point here.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getHealthStatus } from '@/server/observability/service'

export async function GET(_req: NextRequest) {
  const health = await getHealthStatus()
  const status = health.status === 'ok' ? 200 : 503
  const res = NextResponse.json(health, { status })
  // health probes must never be cached
  res.headers.set('cache-control', 'no-store, max-age=0')
  return res
}
