'use client'

/**
 * GamificationOG — Client API helpers.
 * Thin fetch wrappers with typed responses and consistent error surfacing.
 */

export interface ApiErrorPayload {
  error: {
    code: string
    category?: string
    message: string
    detail?: string
    fix?: string
    trace_id?: string
  }
}

export function isApiError(data: unknown): data is ApiErrorPayload {
  return typeof data === 'object' && data !== null && 'error' in data && typeof (data as { error: unknown }).error === 'object'
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(isApiError(data) ? data.error.message : `Request failed (${res.status})`), { payload: data })
  return data as T
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok && !isApiError(data)) throw new Error(`Request failed (${res.status})`)
  return data as T
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(isApiError(data) ? data.error.message : `Request failed (${res.status})`), { payload: data })
  return data as T
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'DELETE', credentials: 'same-origin' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(isApiError(data) ? data.error.message : `Request failed (${res.status})`), { payload: data })
  return data as T
}

export function tryParseJson(raw: string | null | undefined, fallback: unknown = null): unknown {
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function formatRelative(date: string | Date | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string' ? new Date(date) : date
  const diff = Date.now() - d.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString()
}
