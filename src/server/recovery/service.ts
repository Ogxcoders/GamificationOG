/**
 * GamificationOG — Data Replay & Recovery (§102, §101 event replay recovery)
 *
 *   Stored Events → Validate → Replay → Rebuild Projection → Verify → Promote
 *
 * Projection rebuild: the per-user state (progression, variables, wallets,
 * ledger, items, achievements, challenge progress, streaks, leaderboard
 * entries, rule executions) is reset and recomputed by replaying the stored
 * event stream through the engine in REPLAY MODE, which is isolated from
 * external side effects (§102):
 *   - no webhook fan-out (no re-triggering external systems)
 *   - no metrics double-counting
 *   - no new decision traces
 *   - rule executions re-recorded with the ORIGINAL event timestamps so
 *     frequency caps / cooldowns reproduce the original decisions exactly
 *
 * dry-run runs the full rebuild, computes the before/after drift report,
 * then ROLLS BACK (snapshot restore) leaving live state untouched.
 * apply keeps the rebuilt state (promote).
 */
import { db } from '@/lib/db'
import { parseJson } from '../core/types'
import { processEvent } from '../events/gateway'
import { recordAudit } from '../audit/service'
import { PlatformError } from '../core/errors'

// ---------------------------------------------------------------------------
// Validation (stored events must be well-formed before replay)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  total: number
  valid: number
  invalid: number
  problems: Array<{ eventRowId: string; eventId: string; problem: string }>
}

export async function validateStoredEvents(input: {
  projectId: string
  environmentId: string
  appUserIds?: string[]
  from?: Date
  to?: Date
}): Promise<ValidationResult> {
  const where: Record<string, unknown> = {
    projectId: input.projectId,
    environmentId: input.environmentId,
    status: 'processed',
  }
  if (input.appUserIds?.length) where.actorId = { in: input.appUserIds }
  if (input.from || input.to) {
    where.occurredAt = {
      ...(input.from ? { gte: input.from } : {}),
      ...(input.to ? { lte: input.to } : {}),
    }
  }

  const events = await db.event.findMany({
    where: where as never,
    orderBy: { occurredAt: 'asc' },
    select: { id: true, eventId: true, eventType: true, payloadJson: true, actorId: true, occurredAt: true },
  })

  const problems: ValidationResult['problems'] = []
  for (const e of events) {
    if (!e.actorId) problems.push({ eventRowId: e.id, eventId: e.eventId, problem: 'no resolved actor' })
    try {
      JSON.parse(e.payloadJson)
    } catch {
      problems.push({ eventRowId: e.id, eventId: e.eventId, problem: 'payload is not valid JSON' })
    }
    if (Number.isNaN(e.occurredAt.getTime())) {
      problems.push({ eventRowId: e.id, eventId: e.eventId, problem: 'invalid occurredAt' })
    }
  }
  return { total: events.length, valid: events.length - problems.length, invalid: problems.length, problems: problems.slice(0, 50) }
}

// ---------------------------------------------------------------------------
// State snapshotting (per-user projection set)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

interface Snapshot {
  projectId: string
  environmentId: string
  userProgression: Row[]
  userVariable: Row[]
  walletBalance: Row[]
  ledgerTransaction: Row[]
  userItem: Row[]
  userAchievement: Row[]
  challengeProgress: Row[]
  userStreak: Row[]
  leaderboardEntry: Row[]
  ruleExecution: Row[]
}

const SNAPSHOT_TABLES = [
  'userProgression',
  'userVariable',
  'walletBalance',
  'ledgerTransaction',
  'userItem',
  'userAchievement',
  'challengeProgress',
  'userStreak',
  'leaderboardEntry',
] as const

type SnapshotTable = (typeof SNAPSHOT_TABLES)[number]

async function snapshotUsers(projectId: string, environmentId: string, userIds: string[], eventIds: string[]): Promise<Snapshot> {
  const userFilter = { appUserId: { in: userIds } }
  const [userProgression, userVariable, walletBalance, ledgerTransaction, userItem, userAchievement, challengeProgress, userStreak, leaderboardEntry, ruleExecution] =
    await Promise.all([
      db.userProgression.findMany({ where: userFilter }),
      db.userVariable.findMany({ where: userFilter }),
      db.walletBalance.findMany({ where: userFilter }),
      db.ledgerTransaction.findMany({ where: userFilter }),
      db.userItem.findMany({ where: userFilter }),
      db.userAchievement.findMany({ where: userFilter }),
      db.challengeProgress.findMany({ where: userFilter }),
      db.userStreak.findMany({ where: userFilter }),
      db.leaderboardEntry.findMany({ where: userFilter }),
      db.ruleExecution.findMany({ where: { eventId: { in: eventIds } } }),
    ])
  return {
    projectId,
    environmentId,
    userProgression: userProgression as unknown as Row[],
    userVariable: userVariable as unknown as Row[],
    walletBalance: walletBalance as unknown as Row[],
    ledgerTransaction: ledgerTransaction as unknown as Row[],
    userItem: userItem as unknown as Row[],
    userAchievement: userAchievement as unknown as Row[],
    challengeProgress: challengeProgress as unknown as Row[],
    userStreak: userStreak as unknown as Row[],
    leaderboardEntry: leaderboardEntry as unknown as Row[],
    ruleExecution: ruleExecution as unknown as Row[],
  }
}

async function resetProjections(projectId: string, environmentId: string, userIds: string[], eventIds: string[]): Promise<void> {
  const userFilter = { appUserId: { in: userIds } }
  await Promise.all([
    db.userProgression.deleteMany({ where: userFilter }),
    db.userVariable.deleteMany({ where: userFilter }),
    db.walletBalance.deleteMany({ where: userFilter }),
    db.ledgerTransaction.deleteMany({ where: userFilter }),
    db.userItem.deleteMany({ where: userFilter }),
    db.userAchievement.deleteMany({ where: userFilter }),
    db.challengeProgress.deleteMany({ where: userFilter }),
    db.userStreak.deleteMany({ where: userFilter }),
    db.leaderboardEntry.deleteMany({ where: userFilter }),
    db.ruleExecution.deleteMany({ where: { eventId: { in: eventIds } } }),
  ])
}

async function restoreSnapshot(snapshot: Snapshot): Promise<void> {
  // delete whatever the rebuild created, then re-create the original rows
  // (original ids included, so references remain stable)
  const userIds = [
    ...new Set(
      SNAPSHOT_TABLES.flatMap((t) => (snapshot[t] as Row[]).map((r) => r.appUserId as string)).filter(Boolean),
    ),
  ]
  const eventIds = snapshot.ruleExecution.map((r) => r.eventId as string).filter(Boolean)
  if (userIds.length) {
    await resetProjections(snapshot.projectId, snapshot.environmentId, userIds, eventIds)
  } else if (eventIds.length) {
    await db.ruleExecution.deleteMany({ where: { eventId: { in: eventIds } } })
  }
  for (const t of SNAPSHOT_TABLES) {
    const rows = snapshot[t] as Row[]
    if (rows.length) {
      await (db as unknown as Record<string, { createMany: (a: { data: Row[] }) => Promise<unknown> }>)[t].createMany({ data: rows })
    }
  }
  if (snapshot.ruleExecution.length) {
    await db.ruleExecution.createMany({ data: snapshot.ruleExecution as never })
  }
}

// ---------------------------------------------------------------------------
// State summary (for the drift report)
// ---------------------------------------------------------------------------

interface UserSummary {
  user: string
  progression: Array<{ track: string; xp: number; level: number }>
  balances: Array<{ currency: string; balance: number }>
  items: number
  achievements: number
  challengeProgress: number
  streaks: number
  leaderboardEntries: number
  ledgerEntries: number
  variables: number
}

async function summarizeUser(projectId: string, environmentId: string, userId: string, externalId: string): Promise<UserSummary> {
  const [progression, balances, items, achievements, challenges, streaks, entries, ledger, variables] = await Promise.all([
    db.userProgression.findMany({ where: { appUserId: userId }, select: { xp: true, level: true, track: { select: { code: true } } } }),
    db.walletBalance.findMany({ where: { appUserId: userId }, select: { balance: true, currency: { select: { code: true } } } }),
    db.userItem.count({ where: { appUserId: userId } }),
    db.userAchievement.count({ where: { appUserId: userId } }),
    db.challengeProgress.count({ where: { appUserId: userId } }),
    db.userStreak.count({ where: { appUserId: userId } }),
    db.leaderboardEntry.count({ where: { appUserId: userId } }),
    db.ledgerTransaction.count({ where: { appUserId: userId } }),
    db.userVariable.count({ where: { appUserId: userId } }),
  ])
  return {
    user: externalId,
    progression: progression.map((p) => ({ track: p.track.code, xp: p.xp, level: p.level })).sort((a, b) => a.track.localeCompare(b.track)),
    balances: balances.map((b) => ({ currency: b.currency.code, balance: b.balance })).sort((a, b) => a.currency.localeCompare(b.currency)),
    items,
    achievements,
    challengeProgress: challenges,
    streaks,
    leaderboardEntries: entries,
    ledgerEntries: ledger,
    variables,
  }
}

function diffSummaries(before: UserSummary, after: UserSummary): string[] {
  const drift: string[] = []
  const prog = (s: UserSummary) => s.progression.map((p) => `${p.track}:${p.xp}xp/L${p.level}`).join(',')
  if (prog(before) !== prog(after)) drift.push(`progression ${prog(before)} → ${prog(after)}`)
  const bal = (s: UserSummary) => s.balances.map((b) => `${b.currency}=${b.balance}`).join(',')
  if (bal(before) !== bal(after)) drift.push(`balances ${bal(before) || 'none'} → ${bal(after) || 'none'}`)
  for (const key of ['items', 'achievements', 'challengeProgress', 'streaks', 'leaderboardEntries', 'ledgerEntries', 'variables'] as const) {
    if (before[key] !== after[key]) drift.push(`${key} ${before[key]} → ${after[key]}`)
  }
  return drift
}

// ---------------------------------------------------------------------------
// The replay run
// ---------------------------------------------------------------------------

export interface ReplayRunInput {
  projectId: string
  environmentId: string
  externalUserId?: string // omit for all users
  from?: Date
  to?: Date
  dryRun?: boolean
  adminUserId?: string
}

export interface ReplayRunResult {
  runId: string
  status: string
  scope: string
  dryRun: boolean
  userCount: number
  eventCount: number
  validation: ValidationResult
  verdict: 'consistent' | 'drift-corrected' | 'drift-detected'
  driftByUser: Array<{ user: string; changes: string[] }>
  replayedEvents: number
  failedEvents: number
}

export async function runReplayRun(input: ReplayRunInput): Promise<ReplayRunResult> {
  const run = await db.replayRun.create({
    data: {
      projectId: input.projectId,
      environmentId: input.environmentId,
      scope: input.externalUserId ?? 'all',
      dryRun: input.dryRun ?? true,
      status: 'running',
      fromTime: input.from ?? null,
      toTime: input.to ?? null,
    },
  })
  const dryRun = input.dryRun ?? true

  try {
    // ---- 1. Resolve affected users ----
    const users = input.externalUserId
      ? await db.appUser.findMany({
          where: { projectId: input.projectId, environmentId: input.environmentId, externalId: input.externalUserId },
          select: { id: true, externalId: true },
        })
      : await db.appUser.findMany({
          where: { projectId: input.projectId, environmentId: input.environmentId },
          select: { id: true, externalId: true },
        })
    if (users.length === 0) {
      throw new PlatformError({
        code: 'REPLAY_SCOPE_EMPTY',
        category: 'not_found',
        message: `No users matched scope "${input.externalUserId ?? 'all'}".`,
        status: 404,
      })
    }
    const userIds = users.map((u) => u.id)

    // ---- 2. Fetch their stored events (processed only — held/rejected were never applied) ----
    const eventWhere: Record<string, unknown> = {
      projectId: input.projectId,
      environmentId: input.environmentId,
      status: 'processed',
      actorId: { in: userIds },
    }
    if (input.from || input.to) {
      eventWhere.occurredAt = {
        ...(input.from ? { gte: input.from } : {}),
        ...(input.to ? { lte: input.to } : {}),
      }
    }
    const events = await db.event.findMany({
      where: eventWhere as never,
      orderBy: [{ occurredAt: 'asc' }, { receivedAt: 'asc' }],
    })

    // ---- 3. Validate stored events (§102: validate before replay) ----
    const validation = await validateStoredEvents({
      projectId: input.projectId,
      environmentId: input.environmentId,
      appUserIds: userIds,
      from: input.from,
      to: input.to,
    })
    if (validation.invalid > 0) {
      throw new Error(`${validation.invalid} stored events failed validation — refusing to replay`)
    }

    // ---- 4. Snapshot + reset projections ----
    const eventIds = events.map((e) => e.id)
    const snapshot = await snapshotUsers(input.projectId, input.environmentId, userIds, eventIds)
    const before = await Promise.all(
      users.map((u) => summarizeUser(input.projectId, input.environmentId, u.id, u.externalId)),
    )
    await resetProjections(input.projectId, input.environmentId, userIds, eventIds)

    // ---- 5. Replay in original order (replay mode: side-effect isolated) ----
    let replayed = 0
    let failed = 0
    for (const e of events) {
      try {
        await processEvent(
          {
            eventRowId: e.id,
            eventId: e.eventId,
            eventType: e.eventType,
            eventVersion: e.eventVersion,
            projectId: e.projectId,
            environmentId: e.environmentId,
            appUserId: e.actorId as string,
            subjectId: e.subjectId,
            source: e.source,
            occurredAt: e.occurredAt,
            correlationId: e.correlationId ?? e.eventId,
            payload: parseJson<Record<string, unknown>>(e.payloadJson, {}),
          },
          { replay: true, replayRunId: run.id },
        )
        replayed++
      } catch {
        failed++
      }
    }

    // ---- 6. Verify: after-state vs before-state drift report ----
    const after = await Promise.all(
      users.map((u) => summarizeUser(input.projectId, input.environmentId, u.id, u.externalId)),
    )
    const driftByUser = before.map((b, i) => ({
      user: b.user,
      changes: diffSummaries(b, after[i]),
    }))
    const driftCount = driftByUser.filter((d) => d.changes.length > 0).length
    const verdict: ReplayRunResult['verdict'] = driftCount === 0 ? 'consistent' : dryRun ? 'drift-detected' : 'drift-corrected'

    // ---- 7. Promote or roll back ----
    if (dryRun) {
      // §102: dry-run must leave live state untouched — restore the snapshot
      // (delete whatever the rebuild created, re-create the original rows).
      await restoreSnapshot(snapshot)
    }
    await db.replayRun.update({
      where: { id: run.id },
      data: {
        status: dryRun ? 'rolled_back' : 'completed',
        userCount: users.length,
        eventCount: events.length,
        diffJson: JSON.stringify({ verdict, driftByUser, before, after }),
        finishedAt: new Date(),
      },
    })

    if (input.adminUserId) {
      await recordAudit({
        projectId: input.projectId,
        environmentId: input.environmentId,
        actorType: 'human',
        actorId: input.adminUserId,
        action: dryRun ? 'replay.dry_run' : 'replay.apply',
        targetType: 'replayRun',
        targetId: run.id,
        afterJson: JSON.stringify({ scope: run.scope, users: users.length, events: events.length, verdict }),
      })
    }

    return {
      runId: run.id,
      status: dryRun ? 'rolled_back' : 'completed',
      scope: run.scope,
      dryRun,
      userCount: users.length,
      eventCount: events.length,
      validation,
      verdict,
      driftByUser,
      replayedEvents: replayed,
      failedEvents: failed,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db.replayRun.update({
      where: { id: run.id },
      data: { status: 'failed', error: message, finishedAt: new Date() },
    })
    throw err
  }
}

export async function listReplayRuns(projectId: string, environmentId: string, limit = 20) {
  const runs = await db.replayRun.findMany({
    where: { projectId, environmentId },
    orderBy: { startedAt: 'desc' },
    take: limit,
  })
  return runs.map((r) => ({
    id: r.id,
    scope: r.scope,
    dryRun: r.dryRun,
    status: r.status,
    userCount: r.userCount,
    eventCount: r.eventCount,
    verdict: parseJson<{ verdict?: string }>(r.diffJson, {}).verdict ?? null,
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  }))
}
