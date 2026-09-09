/**
 * GET /api/v1/leaderboards?code=...&limit=...&user=...
 * Leaderboard read model with optional "around me" context.
 */
import { NextRequest } from 'next/server'
import { json, apiError, requireApiKey, requireScope } from '@/lib/api'
import { getLeaderboardView } from '@/server/leaderboards/service'
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'state:read')

    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    if (!code) {
      throw new PlatformError({
        code: 'CODE_REQUIRED',
        category: 'validation',
        message: 'Query parameter "code" is required.',
      })
    }
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)
    const externalId = url.searchParams.get('user')

    let aroundUserId: string | undefined
    if (externalId) {
      const user = await db.appUser.findUnique({
        where: {
          projectId_environmentId_externalId: {
            projectId: auth.projectId,
            environmentId: auth.environmentId,
            externalId,
          },
        },
      })
      aroundUserId = user?.id
    }

    const view = await getLeaderboardView({
      leaderboardCode: code,
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      at: new Date(),
      limit,
      aroundUserId,
    })

    if (!view) {
      throw new PlatformError({
        code: 'LEADERBOARD_NOT_FOUND',
        category: 'not_found',
        message: `Leaderboard "${code}" not found.`,
      })
    }

    return json(view)
  } catch (e) {
    return apiError(e)
  }
}
