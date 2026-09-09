/**
 * GamificationOG — API Helpers
 * Consistent auth, error envelope (Section 106), and JSON responses.
 */
import { NextRequest, NextResponse } from 'next/server'
import { PlatformError, toErrorPayload } from '@/server/core/errors'
import { authenticateApiKey } from '@/server/identity/service'
import type { AuthenticatedApiKey } from '@/server/core/types'

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data as Record<string, unknown>, { status })
}

export function apiError(e: unknown): NextResponse {
  if (e instanceof PlatformError) {
    return NextResponse.json(e.toJSON(), { status: e.status })
  }
  console.error('[api] internal error:', e)
  return NextResponse.json(toErrorPayload(e), { status: 500 })
}

/** Authenticate via Authorization: Bearer <api_key> or X-Api-Key header. */
export async function requireApiKey(req: NextRequest): Promise<AuthenticatedApiKey> {
  const auth = req.headers.get('authorization') ?? ''
  const header = req.headers.get('x-api-key') ?? ''
  const secret = auth.startsWith('Bearer ') ? auth.slice(7) : header
  if (!secret) {
    throw new PlatformError({
      code: 'API_KEY_REQUIRED',
      category: 'auth',
      message: 'Provide an API key via the "Authorization: Bearer <key>" or "X-Api-Key" header.',
      fix: 'Create an API key in Settings, or use the playground which authenticates internally.',
    })
  }
  const auth2 = await authenticateApiKey(secret)
  if (!auth2) {
    throw new PlatformError({
      code: 'API_KEY_INVALID',
      category: 'auth',
      message: 'The provided API key is invalid or inactive.',
    })
  }
  return auth2
}

export function requireScope(auth: AuthenticatedApiKey, scope: string): void {
  if (auth.scopes.includes('*')) return
  if (!auth.scopes.includes(scope)) {
    throw new PlatformError({
      code: 'SCOPE_MISSING',
      category: 'auth',
      message: `This API key lacks the required scope "${scope}".`,
      fix: `Add "${scope}" to the key's scopes in Settings.`,
    })
  }
}

/** Require at least one of the given scopes (§67 permission levels). */
export function requireAnyScope(auth: AuthenticatedApiKey, scopes: string[]): void {
  if (auth.scopes.includes('*')) return
  if (!scopes.some((s) => auth.scopes.includes(s))) {
    throw new PlatformError({
      code: 'SCOPE_MISSING',
      category: 'auth',
      message: `This API key lacks any of the required scopes (${scopes.join(' | ')}).`,
      fix: `Add one of: ${scopes.map((s) => `"${s}"`).join(', ')} to the key's scopes in Settings.`,
    })
  }
}

export async function readJson<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new PlatformError({
      code: 'INVALID_JSON',
      category: 'validation',
      message: 'Request body must be valid JSON.',
    })
  }
}

export function requireStringField(obj: Record<string, unknown>, field: string, label?: string): string {
  const v = obj[field]
  if (typeof v !== 'string' || v.length === 0) {
    throw new PlatformError({
      code: 'FIELD_REQUIRED',
      category: 'validation',
      message: `Field "${label ?? field}" is required.`,
    })
  }
  return v
}

export function optionalNumber(obj: Record<string, unknown>, field: string): number | undefined {
  const v = obj[field]
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (Number.isNaN(n)) {
    throw new PlatformError({
      code: 'FIELD_INVALID',
      category: 'validation',
      message: `Field "${field}" must be a number.`,
    })
  }
  return n
}
