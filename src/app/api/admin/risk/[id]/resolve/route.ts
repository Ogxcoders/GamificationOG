/**
 * /api/admin/risk/[id]/resolve — Risk flag adjudication (§74).
 * POST { action: 'release' | 'reject' | 'dismiss' }
 *
 * release  : a held event is pushed through the normal processing pipeline
 *            (side effects fire exactly once — the event row transitions
 *            held → processed; XP/currency/leaderboards update).
 * reject   : the held event is permanently rejected (no side effects ever).
 * dismiss  : closes the flag without touching the event (for throttle flags).
 *
 * Human-only (admin session). Every decision is audited.
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { db } from '@/lib/db'
import { parseJson } from '@/server/core/types'
import { PlatformError } from '@/server/core/errors'
import { processEvent } from '@/server/events/gateway'
import { recordAudit } from '@/server/audit/service'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const { id } = await params
    const body = await readJson<{ action?: string }>(req)

    if (body.action !== 'release' && body.action !== 'reject' && body.action !== 'dismiss') {
      throw new PlatformError({
        code: 'INVALID_ACTION',
        category: 'validation',
        message: `"action" must be "release", "reject" or "dismiss".`,
      })
    }

    const flag = await db.riskFlag.findFirst({
      where: {
        id,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    })
    if (!flag) {
      throw new PlatformError({
        code: 'FLAG_NOT_FOUND',
        category: 'not_found',
        message: `Risk flag ${id} does not exist in this scope.`,
        status: 404,
      })
    }
    if (flag.status !== 'open') {
      throw new PlatformError({
        code: 'FLAG_ALREADY_RESOLVED',
        category: 'conflict',
        message: `Flag ${id} is already ${flag.status}.`,
        status: 409,
      })
    }

    let result: Record<string, unknown> = {}

    if (body.action === 'release') {
      const event = flag.eventRowId
        ? await db.event.findUnique({ where: { id: flag.eventRowId } })
        : null
      if (!event) {
        throw new PlatformError({
          code: 'EVENT_NOT_FOUND',
          category: 'not_found',
          message: `The flagged event row no longer exists — dismiss the flag instead.`,
          status: 404,
        })
      }
      if (event.status !== 'held') {
        throw new PlatformError({
          code: 'EVENT_NOT_HELD',
          category: 'conflict',
          message: `Event ${event.eventId} has status "${event.status}" — only held events can be released.`,
          status: 409,
        })
      }
      // Run the exact normal pipeline (side effects fire once, here).
      const processed = await processEvent({
        eventRowId: event.id,
        eventId: event.eventId,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        projectId: event.projectId,
        environmentId: event.environmentId,
        appUserId: event.actorId as string,
        subjectId: event.subjectId,
        source: event.source,
        occurredAt: event.occurredAt,
        correlationId: event.correlationId ?? event.eventId,
        payload: parseJson<Record<string, unknown>>(event.payloadJson, {}),
      })
      result = {
        eventId: processed.eventId,
        status: processed.status,
        traceId: processed.traceId ?? null,
        actionsExecuted: processed.actions.filter((a) => a.status === 'executed').length,
        xpAwarded: processed.stateDelta.xpAwarded,
      }
    }

    if (body.action === 'reject') {
      const event = flag.eventRowId
        ? await db.event.findUnique({ where: { id: flag.eventRowId } })
        : null
      if (event && event.status === 'held') {
        await db.event.update({
          where: { id: event.id },
          data: {
            status: 'rejected',
            processingError: `Risk flag ${id} rejected by admin review`,
          },
        })
      }
      result = { eventStatus: 'rejected' }
    }

    await db.riskFlag.update({
      where: { id: flag.id },
      data: {
        status: body.action === 'release' ? 'released' : body.action,
        resolvedBy: admin.adminUserId,
        resolvedAt: new Date(),
        resultJson: JSON.stringify(result),
      },
    })

    await recordAudit({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      actorType: 'human',
      actorId: admin.adminUserId,
      action: `risk.flag.${body.action}`,
      targetType: 'riskFlag',
      targetId: flag.id,
      beforeJson: JSON.stringify({ decision: flag.decision, score: flag.score, status: flag.status }),
      afterJson: JSON.stringify(result),
    })

    return json({ flagId: flag.id, action: body.action, result })
  } catch (e) {
    return apiError(e)
  }
}
