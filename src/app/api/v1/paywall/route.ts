/**
 * GET /api/v1/paywall?user=<external_id>&code=<paywall_code> — Paywall
 * evaluation (Sections 43/44): is the user locked, which offers are
 * presented, and client rendering hints.
 */
import { NextRequest } from 'next/server'
import { json, apiError, requireApiKey, requireScope } from '@/lib/api'
import { db } from '@/lib/db'
import { evaluatePaywall } from '@/server/monetization/service'

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'state:read')

    const url = new URL(req.url)
    const externalId = url.searchParams.get('user')
    const code = url.searchParams.get('code')
    if (!externalId || !code) {
      return json({ error: { code: 'PARAMS_REQUIRED', message: 'Query parameters "user" and "code" are required.' } }, 400)
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
      return json({ error: { code: 'USER_NOT_FOUND', message: `User "${externalId}" not found.` } }, 404)
    }

    const evaluation = await evaluatePaywall({
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      appUserId: user.id,
      code,
    })
    return json(evaluation)
  } catch (e) {
    return apiError(e)
  }
}
