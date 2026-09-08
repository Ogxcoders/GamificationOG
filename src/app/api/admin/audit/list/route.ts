/**
 * GET /api/admin/audit — immutable audit log (Section 96).
 */
import { NextRequest } from 'next/server'
import { json, apiError } from '@/lib/api'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin-auth'
import { safeJson } from '@/server/core/types'

export async function GET(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const url = new URL(req.url)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)

    const entries = await db.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    return json({
      entries: entries.map((e) => ({
        id: e.id,
        actorType: e.actorType,
        actorId: e.actorId,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        before: safeJson(e.beforeJson),
        after: safeJson(e.afterJson),
        reason: e.reason,
        createdAt: e.createdAt,
      })),
      viewer: admin.email,
    })
  } catch (e) {
    return apiError(e)
  }
}
