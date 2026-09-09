/**
 * Environment promotion (§ Mode C, Phase 5).
 * GET  — available environments + recent promotions (for the UI card)
 * POST — promote: { from, to, dryRun? } via export→import(overwrite),
 *        validated, transactional, audited.
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { promoteEnvironment } from '@/server/promotion/service'
import { safeJson } from '@/server/core/types'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const environments = await db.environment.findMany({
      where: { projectId: scope.projectId },
      select: { name: true, status: true },
      orderBy: { createdAt: 'asc' },
    })
    const recent = await db.auditLog.findMany({
      where: { projectId: scope.projectId, action: 'environment.promoted' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, afterJson: true, createdAt: true },
    })
    return json({
      environments: environments.map((e) => e.name),
      current: scope.environmentName,
      recent: recent.map((r) => ({ at: r.createdAt, ...safeJson<Record<string, unknown>>(r.afterJson, {}) })),
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const body = await readJson<{ from?: string; to?: string; dryRun?: boolean }>(req)
    if (!body.from || !body.to) {
      return json({ error: { code: 'FIELDS_REQUIRED', message: '"from" and "to" environment names are required.' } }, 400)
    }
    const result = await promoteEnvironment({
      projectId: scope.projectId,
      fromEnvironment: body.from,
      toEnvironment: body.to,
      dryRun: body.dryRun !== false,
      actorId: admin.adminUserId,
    })
    return json(result, result.dryRun ? 200 : 201)
  } catch (e) {
    return apiError(e)
  }
}
