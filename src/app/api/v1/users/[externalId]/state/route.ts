/**
 * GET /api/v1/users/[externalId]/state — Full user state snapshot.
 * XP/levels, wallets, inventory, achievements, challenges, streaks,
 * notifications, variables. The SDK's primary read endpoint.
 */
import { NextRequest } from 'next/server'
import { json, apiError, requireApiKey, requireScope } from '@/lib/api'
import { getUserStateSnapshot } from '@/server/identity/service'
import { PlatformError } from '@/server/core/errors'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ externalId: string }> },
) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'state:read')
    const { externalId } = await params

    const snapshot = await getUserStateSnapshot({
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      externalId: decodeURIComponent(externalId),
    })

    if (!snapshot) {
      throw new PlatformError({
        code: 'USER_NOT_FOUND',
        category: 'not_found',
        message: `User "${externalId}" not found in this environment.`,
        fix: 'Call /api/v1/identify first to create the user.',
      })
    }

    return json(snapshot)
  } catch (e) {
    return apiError(e)
  }
}
