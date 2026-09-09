/**
 * GET  /api/admin/webhook-deliveries — delivery log + endpoint health (§99, §304).
 * POST /api/admin/webhook-deliveries — actions:
 *   { action: 'process_retries' }            — sweep due retries now
 *   { action: 'redeliver', delivery_id }     — manual redelivery
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { processDueWebhookDeliveries, redeliverWebhook } from '@/server/webhooks/service'
import { recordAudit } from '@/server/audit/service'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') ?? 50) || 50, 200)

    const endpoints = await db.webhookEndpoint.findMany({
      where: { projectId: scope.projectId, environmentId: scope.environmentId },
      orderBy: { createdAt: 'desc' },
      include: {
        deliveries: { orderBy: { createdAt: 'desc' }, take: limit },
      },
    })

    const deliveries = await db.webhookDelivery.findMany({
      where: { endpoint: { projectId: scope.projectId, environmentId: scope.environmentId } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { endpoint: { select: { url: true } } },
    })

    return json({
      endpoints: endpoints.map((e) => ({
        id: e.id,
        url: e.url,
        events: JSON.parse(e.eventsJson || '[]') as string[],
        status: e.status,
        hasSecret: !!e.secret,
        deliveries: e.deliveries.length,
        lastDelivery: e.deliveries[0]?.createdAt ?? null,
        successRate:
          e.deliveries.length > 0
            ? Math.round((e.deliveries.filter((d) => d.status === 'delivered').length / e.deliveries.length) * 100)
            : null,
      })),
      deliveries: deliveries.map((d) => ({
        id: d.id,
        endpoint: d.endpoint.url,
        eventType: d.eventType,
        status: d.status,
        attempts: d.attempts,
        statusCode: d.statusCode,
        response: d.response?.slice(0, 200),
        createdAt: d.createdAt,
        lastAttemptAt: d.lastAttemptAt,
      })),
      summary: {
        total: deliveries.length,
        delivered: deliveries.filter((d) => d.status === 'delivered').length,
        retrying: deliveries.filter((d) => d.status === 'retrying').length,
        failed: deliveries.filter((d) => d.status === 'failed').length,
      },
      scope,
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const body = await readJson<{ action: string; delivery_id?: string }>(req)

    if (body.action === 'process_retries') {
      const result = await processDueWebhookDeliveries(50)
      await recordAudit({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        actorType: 'human',
        actorId: admin.adminUserId,
        action: 'webhooks.retries_processed',
        targetType: 'webhooks',
        targetId: 'sweep',
        afterJson: JSON.stringify(result),
      })
      return json({ ok: true, result })
    }

    if (body.action === 'redeliver') {
      if (!body.delivery_id) {
        return json({ error: { code: 'DELIVERY_ID_REQUIRED', message: 'Field "delivery_id" is required.' } }, 400)
      }
      const result = await redeliverWebhook(body.delivery_id)
      if (!result.ok) return json({ error: { code: 'NOT_FOUND', message: 'Delivery not found.' } }, 404)
      await recordAudit({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        actorType: 'human',
        actorId: admin.adminUserId,
        action: 'webhook.redelivered',
        targetType: 'webhook_delivery',
        targetId: body.delivery_id,
      })
      return json({ ok: true, result: result.result })
    }

    return json({ error: { code: 'UNKNOWN_ACTION', message: 'Use process_retries or redeliver.' } }, 400)
  } catch (e) {
    return apiError(e)
  }
}
