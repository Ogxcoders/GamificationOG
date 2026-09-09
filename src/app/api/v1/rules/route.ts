/**
 * GET /api/v1/rules — Rule configuration surface for SDKs and AI agents
 * (MCP control plane, Sections 65, 153, 154).
 *
 * API-key authenticated, scope: "rules:read". Read-only: rules are created
 * and managed via the admin API/dashboard — AI observes configuration,
 * humans own changes (Section 153: human visibility and control).
 */
import { NextRequest } from 'next/server'
import { json, apiError, requireApiKey, requireScope } from '@/lib/api'
import { db } from '@/lib/db'
import { parseJson } from '@/server/core/types'

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'rules:read')
    const url = new URL(req.url)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)
    const status = url.searchParams.get('status')
    const eventType = url.searchParams.get('type')

    const where: Record<string, unknown> = { projectId: auth.projectId, environmentId: auth.environmentId }
    if (status) where.status = status
    if (eventType) where.eventType = eventType

    const rules = await db.rule.findMany({
      where: where as never,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    })

    return json({
      rules: rules.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        when: r.eventType,
        if: parseJson<unknown>(r.conditionsJson, {}),
        then: parseJson<unknown>(r.actionsJson, []),
        priority: r.priority,
        cooldownSeconds: r.cooldownSeconds,
        frequencyCap: r.frequencyCap,
        frequencyPeriod: r.frequencyPeriod,
        status: r.status,
        version: r.version,
      })),
      scope: { projectId: auth.projectId, environmentId: auth.environmentId },
    })
  } catch (e) {
    return apiError(e)
  }
}
