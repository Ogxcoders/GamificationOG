/**
 * POST /api/admin/playground/track — Simulate an event through the full
 * pipeline (Customer Zero: trigger event -> see state change -> see trace).
 * GET  /api/admin/playground/users — list users for the picker.
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { ingestEvent } from '@/server/events/gateway'
import { identifyUser } from '@/server/identity/service'
import { getUserStateSnapshot } from '@/server/identity/service'
import { parseJson } from '@/server/core/types'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const url = new URL(req.url)
    const q = url.searchParams.get('q')
    const stateFor = url.searchParams.get('stateFor')

    if (stateFor) {
      const snapshot = await getUserStateSnapshot({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        externalId: stateFor,
      })
      return json({ state: snapshot })
    }

    const users = await db.appUser.findMany({
      where: {
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        ...(q ? { OR: [{ externalId: { contains: q } }, { displayName: { contains: q } }] } : {}),
      },
      orderBy: { lastSeenAt: 'desc' },
      take: 50,
      include: {
        progression: { include: { track: true } },
        walletBalances: { include: { currency: true } },
        userAchievements: { where: { unlockedAt: { not: null } } },
      },
    })

    const eventSchemas = await db.eventSchema.findMany({
      where: { projectId: scope.projectId, status: 'active' },
      orderBy: { name: 'asc' },
    })

    return json({
      users: users.map((u) => ({
        id: u.id,
        externalId: u.externalId,
        displayName: u.displayName,
        anonymous: u.isAnonymous,
        lastSeenAt: u.lastSeenAt,
        level: u.progression.find((p) => p.track.code === 'default')?.level ?? 1,
        xp: u.progression.find((p) => p.track.code === 'default')?.xp ?? 0,
        balances: u.walletBalances.map((w) => ({ code: w.currency.code, balance: w.balance })),
        achievements: u.userAchievements.length,
      })),
      eventSchemas: eventSchemas.map((s) => ({
        name: s.name,
        version: s.version,
        description: s.description,
        payloadSchema: parseJson<Record<string, unknown>>(s.payloadSchemaJson, {}),
      })),
      scope,
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const body = await readJson<{
      action: 'track'
      external_user_id?: string
      create_user?: boolean
      display_name?: string
      event_type: string
      payload?: Record<string, unknown>
    }>(req)

    if (body.action !== 'track') {
      return json({ error: { code: 'UNKNOWN_ACTION', message: 'Playground supports action "track".' } }, 400)
    }

    let appUserId: string | undefined
    if (body.external_user_id) {
      const user = await db.appUser.findUnique({
        where: {
          projectId_environmentId_externalId: {
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            externalId: body.external_user_id,
          },
        },
      })
      if (user) {
        appUserId = user.id
      } else if (body.create_user) {
        const created = await identifyUser({
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          externalId: body.external_user_id,
          displayName: body.display_name,
          isAnonymous: false,
        })
        appUserId = created.appUserId
      }
    }

    const result = await ingestEvent({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      request: {
        event_type: body.event_type,
        payload: body.payload ?? {},
        source: 'simulator',
        external_user_id: body.external_user_id,
      },
      resolvedAppUserId: appUserId,
    })

    // attach fresh state snapshot after processing
    const snapshot = body.external_user_id
      ? await getUserStateSnapshot({
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          externalId: body.external_user_id,
        })
      : null

    return json({ result, state: snapshot })
  } catch (e) {
    return apiError(e)
  }
}
