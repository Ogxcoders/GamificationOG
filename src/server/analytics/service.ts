/**
 * GamificationOG — Analytics Service (Section 76)
 * Daily aggregate read models. Analytics is separate from runtime state
 * (Section 210) and rebuildable from events (projections).
 */
import { db } from '@/lib/db'
import { dateKey } from '../time/engine'

export interface MetricBump {
  metricType: string
  dimension?: string
  value: number
  mode?: 'increment' | 'set'
}

export async function bumpDailyMetrics(
  projectId: string,
  environmentId: string,
  at: Date,
  bumps: MetricBump[],
): Promise<void> {
  if (bumps.length === 0) return
  const key = dateKey(at)

  // Retry with backoff: SQLite serializes writers, so concurrent transactions can
  // fail transiently ("database is locked"). Metrics must never be silently
  // dropped (§91 reliability) — retry, then fall back to sequential upserts.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ops = bumps.map((b) => {
        const dimension = (b.dimension ?? '').slice(0, 80)
        const where = {
          projectId,
          environmentId,
          dateKey: key,
          metricType: b.metricType,
          dimension,
        }
        return db.metricDaily.upsert({
          where: {
            projectId_environmentId_dateKey_metricType_dimension: {
              projectId,
              environmentId,
              dateKey: key,
              metricType: b.metricType,
              dimension,
            },
          },
          create: { ...where, value: b.value },
          update: b.mode === 'set' ? { value: b.value } : { value: { increment: b.value } },
        })
      })
      await db.$transaction(ops)
      return
    } catch {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 25 * attempt))
        continue
      }
      // final fallback: sequential upserts (each atomic on its own)
      for (const b of bumps) {
        const dimension = (b.dimension ?? '').slice(0, 80)
        await db.metricDaily
          .upsert({
            where: {
              projectId_environmentId_dateKey_metricType_dimension: {
                projectId,
                environmentId,
                dateKey: key,
                metricType: b.metricType,
                dimension,
              },
            },
            create: { projectId, environmentId, dateKey: key, metricType: b.metricType, dimension, value: b.value },
            update: b.mode === 'set' ? { value: b.value } : { value: { increment: b.value } },
          })
          .catch(() => null)
      }
    }
  }
}

export async function trackActiveUser(projectId: string, environmentId: string, appUserId: string, at: Date) {
  await bumpDailyMetrics(projectId, environmentId, at, [{ metricType: 'active_users', value: 1 }])
}

export interface AnalyticsSummary {
  totals: Record<string, number>
  daily: Array<{ date: string; metricType: string; value: number }>
  topEventTypes: Array<{ type: string; count: number }>
  lastNDays: number
}

export async function getAnalyticsSummary(
  projectId: string,
  environmentId: string,
  days = 14,
): Promise<AnalyticsSummary> {
  const now = new Date()
  const from = new Date(now.getTime() - days * 86400000)
  const fromKey = dateKey(from)

  const rows = await db.metricDaily.findMany({
    where: {
      projectId,
      environmentId,
      dateKey: { gte: fromKey },
    },
    orderBy: { dateKey: 'asc' },
  })

  const totals: Record<string, number> = {}
  for (const r of rows) {
    if (r.dimension) continue // totals exclude dimensional rows
    totals[r.metricType] = (totals[r.metricType] ?? 0) + r.value
  }

  const daily = rows
    .filter((r) => !r.dimension)
    .map((r) => ({ date: r.dateKey, metricType: r.metricType, value: r.value }))

  // top event types from raw events (last 7 days)
  const eventTypes = await db.event.groupBy({
    by: ['eventType'],
    where: { projectId, environmentId, occurredAt: { gte: from } },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 10,
  })

  return {
    totals,
    daily,
    topEventTypes: eventTypes.map((e) => ({ type: e.eventType, count: e._count.id })),
    lastNDays: days,
  }
}

export async function rebuildAnalyticsFromEvents(projectId: string, environmentId: string) {
  // clear existing
  await db.metricDaily.deleteMany({ where: { projectId, environmentId } })

  const events = await db.event.findMany({
    where: { projectId, environmentId, occurredAt: { gte: new Date(Date.now() - 30 * 86400000) } },
    select: { occurredAt: true, eventType: true, actorId: true, status: true },
  })

  const dateUserSet = new Set<string>()
  for (const e of events) {
    const key = dateKey(e.occurredAt)
    await bumpDailyMetrics(projectId, environmentId, e.occurredAt, [
      { metricType: 'events_ingested', dimension: e.eventType, value: 1 },
      { metricType: 'events_ingested', value: 1 },
    ])
    // processed metrics mirror the live pipeline (only genuinely processed events)
    if (e.status === 'processed') {
      await bumpDailyMetrics(projectId, environmentId, e.occurredAt, [
        { metricType: 'events_processed', dimension: e.eventType, value: 1 },
        { metricType: 'events_processed', value: 1 },
      ])
    }
    if (e.actorId) {
      dateUserSet.add(`${key}:${e.actorId}`)
    }
  }

  // actions executed — recomputed from rule executions (executedAt buckets)
  const executions = await db.ruleExecution.findMany({
    where: { rule: { projectId, environmentId }, executedAt: { gte: new Date(Date.now() - 30 * 86400000) } },
    select: { executedAt: true, actionsExecuted: true, matched: true },
  })
  const actionsByDay = new Map<string, number>()
  const matchesByDay = new Map<string, number>()
  for (const x of executions) {
    const key = dateKey(x.executedAt)
    actionsByDay.set(key, (actionsByDay.get(key) ?? 0) + x.actionsExecuted)
    if (x.matched) matchesByDay.set(key, (matchesByDay.get(key) ?? 0) + 1)
  }
  for (const [key, actions] of actionsByDay) {
    const [y, m, d] = key.split('-').map(Number)
    await bumpDailyMetrics(projectId, environmentId, new Date(Date.UTC(y, m - 1, d)), [
      { metricType: 'actions_executed', value: actions },
    ])
  }
  for (const [key, matches] of matchesByDay) {
    const [y, m, d] = key.split('-').map(Number)
    await bumpDailyMetrics(projectId, environmentId, new Date(Date.UTC(y, m - 1, d)), [
      { metricType: 'rules_matched', value: matches },
    ])
  }

  const byDay = new Map<string, Set<string>>()
  for (const combined of dateUserSet) {
    const [key, user] = combined.split(':')
    if (!byDay.has(key)) byDay.set(key, new Set())
    byDay.get(key)!.add(user)
  }
  for (const [key, users] of byDay) {
    const [y, m, d] = key.split('-').map(Number)
    await bumpDailyMetrics(projectId, environmentId, new Date(Date.UTC(y, m - 1, d)), [
      { metricType: 'active_users', value: users.size, mode: 'set' },
    ])
  }

  return {
    eventsProcessed: events.filter((e) => e.status === 'processed').length,
    eventsIngested: events.length,
    actionsExecuted: [...actionsByDay.values()].reduce((s, v) => s + v, 0),
    days: byDay.size,
  }
}
