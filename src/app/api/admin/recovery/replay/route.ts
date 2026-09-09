/**
 * /api/admin/recovery/replay — Data replay & recovery console (§102).
 *
 * POST : run a projection rebuild from stored events.
 *        Body: { external_user_id?: string, from?: ISO, to?: ISO, dry_run?: boolean }
 *        dry-run (default true) = rebuild + drift report + rollback;
 *        dry_run false = rebuild + promote.
 * GET  : list recent replay runs (scope, verdict, drift counts).
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { runReplayRun, listReplayRuns } from '@/server/recovery/service'
import { PlatformError } from '@/server/core/errors'

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const url = new URL(req.url)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 100)
    const runs = await listReplayRuns(scope.projectId, scope.environmentId, limit)
    return json({ runs })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const body = await readJson<{
      external_user_id?: string
      from?: string
      to?: string
      dry_run?: boolean
    }>(req)

    const from = parseDate(body.from)
    const to = parseDate(body.to)
    if (body.from && !from) {
      throw new PlatformError({ code: 'INVALID_DATE', category: 'validation', message: '"from" must be an ISO date string.' })
    }
    if (body.to && !to) {
      throw new PlatformError({ code: 'INVALID_DATE', category: 'validation', message: '"to" must be an ISO date string.' })
    }
    if (from && to && from > to) {
      throw new PlatformError({ code: 'INVALID_RANGE', category: 'validation', message: '"from" must be before "to".' })
    }

    const result = await runReplayRun({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      externalUserId: body.external_user_id,
      from,
      to,
      dryRun: body.dry_run !== false,
      adminUserId: admin.adminUserId,
    })
    return json({ result })
  } catch (e) {
    return apiError(e)
  }
}
