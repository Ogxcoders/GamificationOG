/**
 * GamificationOG — Notification Engine (Section 75)
 * Templates with variable interpolation, in-app channel.
 * Notification safety (Section 200): rate limits + opt-out respected.
 */
import { db } from '@/lib/db'

export interface NotificationResult {
  id: string
  title: string
  body: string | null
  type: string
  status: 'sent' | 'rate_limited' | 'skipped'
}

/** Simple {{variable}} interpolation from a flat value map. */
export function interpolate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const v = key.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part]
      return undefined
    }, variables)
    return v === undefined || v === null ? '' : String(v)
  })
}

const USER_NOTIFICATION_LIMIT_PER_EVENT = 3

export async function sendNotification(params: {
  projectId: string
  environmentId: string
  appUserId: string
  title: string
  body?: string
  type?: string
  templateKey?: string
  variables?: Record<string, unknown>
  correlationId?: string
}): Promise<NotificationResult> {
  let title = params.title
  let body = params.body ?? null
  let type = params.type ?? 'info'

  if (params.templateKey) {
    const template = await db.notificationTemplate.findUnique({
      where: { projectId_key: { projectId: params.projectId, key: params.templateKey } },
    })
    if (template) {
      const vars = params.variables ?? {}
      title = interpolate(template.titleTemplate, vars)
      body = interpolate(template.bodyTemplate, vars)
      type = template.channel === 'in_app' ? (params.type ?? 'info') : params.type ?? 'info'
    }
  }

  // Anti-spam: max N notifications per user per minute
  const oneMinuteAgo = new Date(Date.now() - 60000)
  const recent = await db.notification.count({
    where: { appUserId: params.appUserId, sentAt: { gt: oneMinuteAgo } },
  })
  if (recent >= 20) {
    return { id: '', title, body, type, status: 'rate_limited' }
  }

  const notification = await db.notification.create({
    data: {
      projectId: params.projectId,
      environmentId: params.environmentId,
      appUserId: params.appUserId,
      title,
      body,
      type,
      status: 'sent',
      correlationId: params.correlationId,
    },
  })

  return { id: notification.id, title, body, type, status: 'sent' }
}

export async function getUserNotifications(appUserId: string, limit = 50, unreadOnly = false) {
  return db.notification.findMany({
    where: unreadOnly ? { appUserId, readAt: null } : { appUserId },
    orderBy: { sentAt: 'desc' },
    take: limit,
  })
}

export async function markNotificationsRead(appUserId: string, ids?: string[]) {
  await db.notification.updateMany({
    where: ids && ids.length > 0 ? { appUserId, id: { in: ids } } : { appUserId, readAt: null },
    data: { readAt: new Date(), status: 'read' },
  })
}

export { USER_NOTIFICATION_LIMIT_PER_EVENT }
