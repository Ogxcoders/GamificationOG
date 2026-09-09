/**
 * GamificationOG — Webhook delivery engine (Sections 99, 304).
 * Outbound webhooks with HMAC-SHA256 signatures, timeouts, exponential
 * backoff retries, and dead-lettering. Deliveries are an outbox:
 * rows are created transactionally then attempted async (§347).
 */
import { createHmac, randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { parseJson } from '@/server/core/types'

const MAX_ATTEMPTS = 5
const BACKOFF_SECONDS = [5, 30, 120, 600, 3600]
const TIMEOUT_MS = 5000

export interface WebhookEventPayload {
  id: string
  type: string
  occurred_at: string
  project_id: string
  environment_id: string
  user?: { id: string; external_id: string } | null
  data: Record<string, unknown>
}

function signature(secret: string, timestamp: string, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
}

/** Subscribe check: endpoint eventsJson is a list of event types or ["*"]. */
function endpointSubscribed(eventsJson: string, eventType: string): boolean {
  const events = parseJson<string[]>(eventsJson, [])
  if (events.length === 0 || events.includes('*')) return true
  return events.includes(eventType)
}

/**
 * Fan an engine event out to all subscribed, active endpoints.
 * Creates delivery rows + attempts the first delivery immediately.
 */
export async function dispatchWebhooks(params: {
  projectId: string
  environmentId: string
  eventType: string
  eventId: string | null
  payload: WebhookEventPayload
}) {
  const endpoints = await db.webhookEndpoint.findMany({
    where: { projectId: params.projectId, environmentId: params.environmentId, status: 'active' },
  })
  const targets = endpoints.filter((e) => endpointSubscribed(e.eventsJson, params.eventType))
  if (targets.length === 0) return { dispatched: 0 }

  const body = JSON.stringify(params.payload)
  const deliveries: string[] = []
  for (const endpoint of targets) {
    const delivery = await db.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventId: params.eventId,
        eventType: params.eventType,
        payloadJson: body,
        status: 'pending',
      },
    })
    deliveries.push(delivery.id)
  }

  // attempt immediate delivery (best-effort, non-blocking failures)
  let delivered = 0
  for (const id of deliveries) {
    const result = await attemptDelivery(id)
    if (result === 'delivered') delivered++
  }
  return { dispatched: deliveries.length, delivered, endpoints: targets.length }
}

/** One delivery attempt with signature, timeout, retry scheduling. */
async function attemptDelivery(deliveryId: string): Promise<'delivered' | 'retrying' | 'failed'> {
  const delivery = await db.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: true } })
  if (!delivery || delivery.status === 'delivered' || delivery.status === 'failed') return 'failed'

  const endpoint = delivery.endpoint
  const attempts = delivery.attempts + 1
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const secret = endpoint.secret ?? ''

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-gog-event': delivery.eventType,
      'x-gog-delivery': delivery.id,
      'x-gog-timestamp': timestamp,
    }
    if (secret) headers['x-gog-signature'] = signature(secret, timestamp, delivery.payloadJson)

    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers,
      body: delivery.payloadJson,
      signal: controller.signal,
    })
    clearTimeout(timeout)
    const responseText = (await res.text()).slice(0, 512)

    if (res.ok) {
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'delivered', statusCode: res.status, response: responseText, attempts, lastAttemptAt: new Date() },
      })
      await db.webhookDeliverySchedule.deleteMany({ where: { deliveryId: delivery.id } })
      return 'delivered'
    }

    // non-2xx: retry with backoff if attempts remain, else dead-letter
    return await scheduleRetryOrFail(delivery.id, attempts, res.status, responseText)
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    return await scheduleRetryOrFail(delivery.id, attempts, 0, `network error: ${err.slice(0, 200)}`)
  }
}

async function scheduleRetryOrFail(deliveryId: string, attempts: number, statusCode: number, response: string): Promise<'retrying' | 'failed'> {
  if (attempts >= MAX_ATTEMPTS) {
    await db.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'failed', statusCode, response, attempts, lastAttemptAt: new Date() },
    })
    await db.webhookDeliverySchedule.deleteMany({ where: { deliveryId } })
    return 'failed'
  }
  const backoff = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]
  const nextAttemptAt = new Date(Date.now() + backoff * 1000)
  await db.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: 'retrying', statusCode, response, attempts, lastAttemptAt: new Date() },
  })
  await db.webhookDeliverySchedule.upsert({
    where: { deliveryId },
    create: { deliveryId, nextAttemptAt },
    update: { nextAttemptAt },
  })
  return 'retrying'
}

/** Sweep due retries (called from the admin API or a cron). */
export async function processDueWebhookDeliveries(limit = 25) {
  const due = await db.webhookDeliverySchedule.findMany({
    where: { nextAttemptAt: { lte: new Date() } },
    take: limit,
    orderBy: { nextAttemptAt: 'asc' },
  })
  let delivered = 0
  let retrying = 0
  let failed = 0
  for (const s of due) {
    const result = await attemptDelivery(s.deliveryId)
    if (result === 'delivered') delivered++
    else if (result === 'retrying') retrying++
    else failed++
  }
  return { attempted: due.length, delivered, retrying, failed }
}

/** Register a local receiver endpoint for testing (in-process HTTP server). */
export function makeTestPayload(eventType: string, data: Record<string, unknown>, user?: { id: string; external_id: string }): WebhookEventPayload {
  return {
    id: randomUUID(),
    type: eventType,
    occurred_at: new Date().toISOString(),
    project_id: '',
    environment_id: '',
    user: user ?? null,
    data,
  }
}

/** Redelivery by id (admin action, §304 webhook reconciliation). */
export async function redeliverWebhook(deliveryId: string) {
  const delivery = await db.webhookDelivery.findUnique({ where: { id: deliveryId } })
  if (!delivery) return { ok: false, error: 'not_found' as const }
  await db.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: 'pending', attempts: 0 },
  })
  await db.webhookDeliverySchedule.deleteMany({ where: { deliveryId } })
  const result = await attemptDelivery(deliveryId)
  return { ok: true, result }
}
