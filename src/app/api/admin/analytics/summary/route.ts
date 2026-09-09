/**
 * GET  /api/admin/analytics — dashboard metrics + charts data (Section 76).
 * POST /api/admin/analytics — rebuild aggregates from raw events.
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { getAnalyticsSummary, rebuildAnalyticsFromEvents } from '@/server/analytics/service'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const url = new URL(req.url)
    const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 14) || 14, 1), 90)

    const summary = await getAnalyticsSummary(scope.projectId, scope.environmentId, days)

    // live counters
    const [totalUsers, totalEvents, activeToday, rulesActive, challengesActive, unreadNotifications] = await Promise.all([
      db.appUser.count({ where: { projectId: scope.projectId, environmentId: scope.environmentId } }),
      db.event.count({ where: { projectId: scope.projectId, environmentId: scope.environmentId } }),
      db.appUser.count({ where: { projectId: scope.projectId, environmentId: scope.environmentId, lastSeenAt: { gte: new Date(Date.now() - 86400000) } } }),
      db.rule.count({ where: { projectId: scope.projectId, environmentId: scope.environmentId, status: 'active' } }),
      db.challenge.count({ where: { projectId: scope.projectId, environmentId: scope.environmentId, status: 'active' } }),
      db.notification.count({ where: { projectId: scope.projectId, environmentId: scope.environmentId, readAt: null } }),
    ])

    const recentTraces = await db.decisionTrace.findMany({
      where: { projectId: scope.projectId, environmentId: scope.environmentId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, eventType: true, summary: true, actionsCount: true, durationMs: true, createdAt: true },
    })

    const recentEvents = await db.event.findMany({
      where: { projectId: scope.projectId, environmentId: scope.environmentId },
      orderBy: { receivedAt: 'desc' },
      take: 8,
      select: { eventId: true, eventType: true, status: true, source: true, receivedAt: true, appUser: { select: { externalId: true, displayName: true } } },
    })

    const topAchievements = await db.userAchievement.groupBy({
      by: ['achievementId'],
      where: { unlockedAt: { not: null }, achievement: { projectId: scope.projectId, environmentId: scope.environmentId } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    })

    return json({
      counters: {
        totalUsers, totalEvents, activeToday, rulesActive, challengesActive, unreadNotifications,
      },
      summary,
      recentTraces,
      recentEvents: recentEvents.map((e) => ({
        ...e,
        user: e.appUser ? (e.appUser.displayName ?? e.appUser.externalId) : null,
      })),
      topAchievements: topAchievements.length,
      scope,
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const body = await readJson<{ action: string }>(req).catch(() => ({ action: 'rebuild' }))
    if (body.action !== 'rebuild') {
      return json({ error: { code: 'UNKNOWN_ACTION', message: 'Use { "action": "rebuild" }' } }, 400)
    }
    const result = await rebuildAnalyticsFromEvents(scope.projectId, scope.environmentId)
    return json({ ok: true, ...result, by: admin.email })
  } catch (e) {
    return apiError(e)
  }
}
