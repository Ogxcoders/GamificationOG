/**
 * POST /api/v1/identify — Identify (or create) an end user (Section 9).
 * Supports anonymous identity, profile attributes, and anonymous -> known
 * identity merge with progress preservation.
 */
import { NextRequest } from 'next/server'
import { json, apiError, requireApiKey, requireScope, readJson } from '@/lib/api'
import { identifyUser } from '@/server/identity/service'
import { bumpDailyMetrics } from '@/server/analytics/service'
import { enforceResidency, assertedRegion } from '@/server/regions/service'
import { PlatformError } from '@/server/core/errors'

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'events:write')
    const body = await readJson<{
      external_id: string
      display_name?: string
      anonymous?: boolean
      attributes?: Record<string, unknown>
      merge_from_external_id?: string
      provider?: string
      provider_account_id?: string
    }>(req)

    if (!body.external_id || typeof body.external_id !== 'string') {
      return json({ error: { code: 'FIELD_REQUIRED', message: 'Field "external_id" is required.' } }, 400)
    }

    // Residency guard (§ Phase 5) — region from attributes or x-gog-region header
    const decision = await enforceResidency({
      projectId: auth.projectId,
      userRegion: assertedRegion((body.attributes ?? {}) as Record<string, unknown>, req.headers.get('x-gog-region')),
    })
    if (!decision.ok) {
      throw new PlatformError({
        code: 'RESIDENCY_VIOLATION',
        category: 'validation',
        message: decision.reason ?? 'Data residency policy violation.',
        status: 422,
        detail: `project region=${decision.projectRegion}, asserted region=${decision.userRegion}`,
        fix: 'Route this traffic to the region pinned for the project, or relax the region policy.',
      })
    }

    const result = await identifyUser({
      projectId: auth.projectId,
      environmentId: auth.environmentId,
      externalId: body.external_id,
      displayName: body.display_name,
      isAnonymous: body.anonymous ?? false,
      attributes: body.attributes,
      mergeFromExternalId: body.merge_from_external_id,
      provider: body.provider,
      providerAccountId: body.provider_account_id,
    })

    if (result.created) {
      await bumpDailyMetrics(auth.projectId, auth.environmentId, new Date(), [
        { metricType: 'new_users', value: 1 },
      ])
    }

    return json({
      user_id: result.appUserId,
      external_id: body.external_id,
      created: result.created,
      merged: result.merged,
    })
  } catch (e) {
    return apiError(e)
  }
}
