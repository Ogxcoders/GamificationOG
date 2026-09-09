/**
 * GET /api/v1/flags — Feature flag + experiment variant evaluation for
 * the calling user (Section 36). Also returns remote config values,
 * personalized per user via targeting rules (Section 34).
 */
import { NextRequest } from 'next/server'
import { json, apiError, requireApiKey, requireScope } from '@/lib/api'
import { evaluateFeatureFlags, assignExperiments, getRemoteConfigs } from '@/server/segments/service'
import { db } from '@/lib/db'
import { evaluateUserSegments } from '@/server/segments/service'
import { personalizeConfig } from '@/server/personalization/service'

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'state:read')

    const url = new URL(req.url)
    const externalId = url.searchParams.get('user')
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
      return json({ error: { code: 'USER_NOT_FOUND', message: `User "${externalId}" not found.` } }, 404)
    }

    const attributes = JSON.parse(user.attributesJson || '{}') as Record<string, unknown>
    const preContext = {
      user: {
        external_id: user.externalId,
        display_name: user.displayName,
        anonymous: user.isAnonymous,
        attribute: attributes,
        level: 0,
        xp: 0,
        currency: {},
        item: {},
      },
    }
    const segments = await evaluateUserSegments({
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      context: preContext as Record<string, unknown>,
    })

    const [flags, experiments, config] = await Promise.all([
      evaluateFeatureFlags({
        projectId: auth.projectId,
        environmentId: auth.environmentId,
        appUserId: user.id,
        segmentIds: segments.ids,
      }),
      assignExperiments({
        projectId: auth.projectId,
        environmentId: auth.environmentId,
        appUserId: user.id,
      }),
      getRemoteConfigs(auth.projectId, auth.environmentId),
    ])

    // Personalization layer (§34): targeted overrides of base config values
    const { config: personalizedConfig, applied } = await personalizeConfig({
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      appUserId: user.id,
      config,
    })

    return json({ flags, experiments, config: personalizedConfig, config_overridden: applied, segments: segments.names })
  } catch (e) {
    return apiError(e)
  }
}
