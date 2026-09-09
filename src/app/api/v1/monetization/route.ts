/**
 * GET /api/v1/monetization?user=<external_id> — SDK-facing monetization
 * state: entitlements, subscriptions, and targeted offers (Sections
 * 39, 40, 45). Lets a client render entitlement-gated UI and offer
 * shelves from one round trip.
 */
import { NextRequest } from 'next/server'
import { json, apiError, requireApiKey, requireScope } from '@/lib/api'
import { db } from '@/lib/db'
import { getOffersForUser, getUserEntitlements, getUserSubscriptions } from '@/server/monetization/service'

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'state:read')

    const externalId = new URL(req.url).searchParams.get('user')
    if (!externalId) {
      return json({ error: { code: 'USER_REQUIRED', message: 'Query parameter "user" (external id) is required.' } }, 400)
    }
    const user = await db.appUser.findUnique({
      where: {
        projectId_environmentId_externalId: {
          projectId: auth.projectId,
          environmentId: auth.environmentId,
          externalId,
        },
      },
    })
    if (!user) {
      return json({ error: { code: 'USER_NOT_FOUND', message: `User "${externalId}" not found. Call identify first.` } }, 404)
    }

    const [entitlements, subscriptions, offers] = await Promise.all([
      getUserEntitlements(auth.projectId, auth.environmentId, user.id),
      getUserSubscriptions(auth.projectId, auth.environmentId, user.id),
      getOffersForUser(auth.projectId, auth.environmentId, user.id),
    ])

    return json({ entitlements, subscriptions, offers })
  } catch (e) {
    return apiError(e)
  }
}
