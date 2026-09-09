/**
 * /api/admin/risk — Universal risk engine console (§74 Fraud/Abuse/Anti-Cheat).
 *
 * GET  : list risk flags (filter by status/decision) + the active config
 *        + aggregate counts for the review queue.
 * POST : upsert the per-project+environment RiskConfig (all fields optional;
 *        omitted fields keep their current values). Admin session required.
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { db } from '@/lib/db'
import { getRiskConfig, upsertRiskConfig, serializeFlag, DEFAULT_RISK_CONFIG } from '@/server/security/risk'
import { recordAudit } from '@/server/audit/service'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const url = new URL(req.url)
    const status = url.searchParams.get('status')
    const decision = url.searchParams.get('decision')
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200)

    const where: Record<string, unknown> = {
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    }
    if (status) where.status = status
    if (decision) where.decision = decision

    const [flags, total, open, held, rejected, config] = await Promise.all([
      db.riskFlag.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      db.riskFlag.count({ where: { projectId: scope.projectId, environmentId: scope.environmentId } }),
      db.riskFlag.count({
        where: { projectId: scope.projectId, environmentId: scope.environmentId, status: 'open' },
      }),
      db.riskFlag.count({
        where: { projectId: scope.projectId, environmentId: scope.environmentId, status: 'open', decision: 'hold' },
      }),
      db.riskFlag.count({
        where: { projectId: scope.projectId, environmentId: scope.environmentId, status: 'open', decision: 'reject' },
      }),
      getRiskConfig(scope.projectId, scope.environmentId),
    ])

    return json({
      flags: flags.map(serializeFlag),
      counts: { total, open, held, rejected },
      config: config ?? { ...DEFAULT_RISK_CONFIG, enabled: false },
      configActive: config !== null,
      scope: { projectId: scope.projectId, environmentId: scope.environmentId },
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const body = await readJson<Record<string, unknown>>(req)

    const config = await upsertRiskConfig(scope.projectId, scope.environmentId, body)

    await recordAudit({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      actorType: 'human',
      actorId: admin.adminUserId,
      action: 'risk.config.update',
      targetType: 'riskConfig',
      targetId: `${scope.projectId}:${scope.environmentId}`,
      afterJson: JSON.stringify(config),
    })

    return json({ config })
  } catch (e) {
    return apiError(e)
  }
}
