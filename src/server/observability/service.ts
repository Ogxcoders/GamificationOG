/**
 * GamificationOG — Observability service (§ Advanced observability)
 * Liveness/readiness checks and Prometheus exposition metrics.
 */
import { db } from '@/lib/db'
import { connectionCount as realtimeConnections } from '../realtime/hub'

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down'
  uptimeSeconds: number
  checks: {
    database: { ok: boolean; latencyMs?: number; error?: string }
    engine: { ok: boolean; actionRegistrySize: number; conditionOperators: number }
  }
  version: string
  timestamp: string
}

const STARTED_AT = Date.now()

export async function getHealthStatus(): Promise<HealthStatus> {
  const checks = await Promise.all([checkDatabase(), checkEngine()])
  const allOk = checks.every((c) => c.ok)
  return {
    status: allOk ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    checks: { database: checks[0], engine: checks[1] },
    version: process.env.npm_package_version ?? '0.2.1',
    timestamp: new Date().toISOString(),
  }
}

async function checkDatabase(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const t0 = Date.now()
  try {
    await db.$queryRaw`SELECT 1`
    return { ok: true, latencyMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'database unreachable' }
  }
}

async function checkEngine() {
  try {
    const { getActionRegistry } = await import('@/server/engine/actions')
    const { COMPARISON_OPERATORS } = await import('@/server/engine/condition')
    const actions = getActionRegistry()
    return { ok: actions.length > 0, actionRegistrySize: actions.length, conditionOperators: COMPARISON_OPERATORS.length }
  } catch {
    return { ok: false, actionRegistrySize: 0, conditionOperators: 0 }
  }
}

// ---------------------------------------------------------------------------
// Prometheus exposition (text format 0.0.4)
// ---------------------------------------------------------------------------

function esc(v: string | number): string {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

export async function getPrometheusMetrics(): Promise<string> {
  const lines: string[] = []
  const push = (
    name: string,
    help: string,
    type: 'counter' | 'gauge',
    samples: Array<{ labels?: Record<string, string | number>; value: number }>,
  ) => {
    lines.push(`# HELP ${name} ${help}`)
    lines.push(`# TYPE ${name} ${type}`)
    for (const s of samples) {
      const labelStr = s.labels
        ? `{${Object.entries(s.labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}`
        : ''
      lines.push(`${name}${labelStr} ${s.value}`)
    }
  }

  // process metrics
  const mem = process.memoryUsage()
  push('gog_process_resident_memory_bytes', 'Resident memory used by the app process', 'gauge', [{ value: mem.rss }])
  push('gog_process_heap_used_bytes', 'Heap used by the app process', 'gauge', [{ value: mem.heapUsed }])
  push('gog_process_uptime_seconds', 'Process uptime in seconds', 'gauge', [
    { value: Math.floor((Date.now() - STARTED_AT) / 1000) },
  ])

  // domain counters (global — the endpoint is admin-authenticated)
  const [users, events, traces, rules, ruleExec, actions, webhooks, proposals, sessions, failures, recentEvents, riskFlags, riskOpen, riskHeld] =
    await Promise.all([
      db.appUser.count(),
      db.event.count(),
      db.decisionTrace.count(),
      db.rule.count(),
      db.ruleExecution.count(),
      db.auditLog.count({ where: { projectId: { not: 'global' } } }),
      db.webhookDelivery.count(),
      db.proposal.count(),
      db.adminSession.count({ where: { expiresAt: { gt: new Date() } } }),
      db.auditLog.count({ where: { action: 'admin.login_failed' } }),
      db.event.count({ where: { receivedAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
      db.riskFlag.count(),
      db.riskFlag.count({ where: { status: 'open' } }),
      db.event.count({ where: { status: 'held' } }),
    ])

  push('gog_users_total', 'Registered app users', 'counter', [{ value: users }])
  push('gog_events_total', 'Ingested events', 'counter', [{ value: events }])
  push('gog_events_24h', 'Events ingested in the last 24h', 'gauge', [{ value: recentEvents }])
  push('gog_decision_traces_total', 'Recorded decision traces', 'counter', [{ value: traces }])
  push('gog_rules_total', 'Configured rules', 'gauge', [{ value: rules }])
  push('gog_rule_executions_total', 'Rule executions', 'counter', [{ value: ruleExec }])
  push('gog_admin_actions_total', 'Audited admin mutations', 'counter', [{ value: actions }])
  push('gog_proposals_total', 'AI proposals created', 'counter', [{ value: proposals }])
  push('gog_webhook_deliveries_total', 'Webhook delivery attempts', 'counter', [{ value: webhooks }])
  push('gog_admin_sessions_active', 'Active admin sessions', 'gauge', [{ value: sessions }])
  push('gog_login_failures_total', 'Failed admin logins (audited)', 'counter', [{ value: failures }])
  push('gog_risk_flags_total', 'Risk engine flags raised (§74 anti-cheat)', 'counter', [{ value: riskFlags }])
  push('gog_risk_flags_open', 'Risk flags awaiting review', 'gauge', [{ value: riskOpen }])
  push('gog_events_held', 'Events held by the risk engine', 'gauge', [{ value: riskHeld }])
  push('gog_realtime_connections', 'Active realtime SSE connections (§78)', 'gauge', [{ value: realtimeConnections() }])

  return `${lines.join('\n')}\n`
}
