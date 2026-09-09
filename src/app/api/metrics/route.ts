/**
 * GET /api/metrics — Prometheus exposition (admin session OR bearer metrics token).
 * Protect with an allowlist via reverse proxy (e.g. Caddy ip matcher) or use
 * the GOG_METRICS_TOKEN bearer token documented in DEPLOYMENT.md.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { getPrometheusMetrics } from '@/server/observability/service'

function unauthorized() {
  return NextResponse.json(
    { error: { code: 'UNAUTHENTICATED', category: 'auth', message: 'Metrics require an admin session or GOG_METRICS_TOKEN bearer.' } },
    { status: 401 },
  )
}

export async function GET(req: NextRequest) {
  // fast path: static bearer token (constant-time compare)
  const expected = process.env.GOG_METRICS_TOKEN
  if (expected) {
    const auth = req.headers.get('authorization') ?? ''
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const a = Buffer.from(provided)
    const b = Buffer.from(expected)
    const tokenOk = a.length === b.length && a.equals(b)
    if (tokenOk) {
      const body = await getPrometheusMetrics()
      return new NextResponse(body, {
        headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (provided) return unauthorized()
  }
  // admin session path
  try {
    await requireAdmin(req)
  } catch {
    return unauthorized()
  }
  const body = await getPrometheusMetrics()
  return new NextResponse(body, {
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
  })
}
