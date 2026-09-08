/**
 * POST /api/v1/checkout/complete — resolve a checkout session with the
 * simulated payment provider (§41). Exactly-once; grants subscriptions,
 * entitlements, or currency per product type. Real providers invoke the
 * same underlying contract from their webhook handler.
 *
 * Body: { session_id: string, outcome?: 'success' | 'failure' }
 */
import { NextRequest } from 'next/server'
import { json, apiError, requireApiKey, requireScope, readJson } from '@/lib/api'
import { completeCheckoutSession } from '@/server/monetization/service'
import { recordAudit } from '@/server/audit/service'

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'events:write')

    const body = await readJson<{ session_id: string; outcome?: 'success' | 'failure' }>(req)
    if (!body?.session_id) {
      return json({ error: { code: 'SESSION_REQUIRED', message: 'Field "session_id" is required.' } }, 400)
    }

    const result = await completeCheckoutSession({
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      sessionId: body.session_id,
      outcome: body.outcome ?? 'success',
    })

    if (result.status === 'completed') {
      await recordAudit({
        projectId: auth.projectId,
        environmentId: auth.environmentId,
        actorType: 'api_key',
        actorId: auth.apiKeyId ?? 'unknown',
        action: 'checkout.completed',
        targetType: 'checkout_session',
        targetId: body.session_id,
        afterJson: JSON.stringify({ product: result.session?.productCode, price: result.session?.priceJson }),
      })
    }

    return json(result)
  } catch (e) {
    return apiError(e)
  }
}
