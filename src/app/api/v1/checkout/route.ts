/**
 * POST /api/v1/checkout — create a checkout session (§41 provider
 * abstraction). With the bundled simulated provider, clients call
 * /api/v1/checkout/complete to resolve the payment; real providers
 * complete via their own webhook callback into the same contract.
 *
 * Body: { user: external_id, product_code, tier?, offer_code? }
 */
import { NextRequest } from 'next/server'
import { json, apiError, requireApiKey, requireScope, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { createCheckoutSession } from '@/server/monetization/service'

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'events:write')

    const body = await readJson<{ user: string; product_code: string; tier?: string; offer_code?: string }>(req)
    if (!body?.user || !body?.product_code) {
      return json({ error: { code: 'FIELDS_REQUIRED', message: 'Fields "user" and "product_code" are required.' } }, 400)
    }

    const user = await db.appUser.findUnique({
      where: {
        projectId_environmentId_externalId: {
          projectId: auth.projectId,
          environmentId: auth.environmentId,
          externalId: body.user,
        },
      },
    })
    if (!user) {
      return json({ error: { code: 'USER_NOT_FOUND', message: `User "${body.user}" not found. Call identify first.` } }, 404)
    }

    const { session, price, product } = await createCheckoutSession({
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      appUserId: user.id,
      productCode: body.product_code,
      tier: body.tier,
      offerCode: body.offer_code,
    })

    return json(
      {
        session_id: session.id,
        status: session.status,
        provider: session.provider,
        product: { code: product.code, name: product.name, type: product.type },
        price,
        next: `POST /api/v1/checkout/complete { "session_id": "${session.id}" } (simulated provider)`,
      },
      201,
    )
  } catch (e) {
    return apiError(e)
  }
}
