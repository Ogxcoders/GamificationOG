/**
 * SCIM route helpers — bearer auth + RFC 7644 error envelope.
 */
import { NextRequest, NextResponse } from 'next/server'
import { authenticateScimToken } from '@/server/scim/service'
import { PlatformError } from '@/server/core/errors'

const SCIM_SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error'

export function scimJson(data: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(data as Record<string, unknown>, { status, headers })
}

export function scimErrorResponse(e: unknown): NextResponse {
  if (e instanceof PlatformError) {
    return scimJson(
      { schemas: [SCIM_SCHEMA_ERROR], status: e.status, detail: `${e.message}${e.detail ? ` (${e.detail})` : ''}` },
      e.status,
    )
  }
  console.error('[scim] internal error:', e)
  return scimJson(
    { schemas: [SCIM_SCHEMA_ERROR], status: 500, detail: 'Internal error' },
    500,
  )
}

export function requireScimAuth(): (req: NextRequest) => Promise<NextResponse | null> {
  return async (req: NextRequest) => {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!token) {
      return scimJson(
        { schemas: [SCIM_SCHEMA_ERROR], status: 401, detail: 'Authorization: Bearer <SCIM token> required' },
        401,
        { 'www-authenticate': 'Bearer' },
      )
    }
    const ok = await authenticateScimToken(token)
    if (!ok) {
      return scimJson({ schemas: [SCIM_SCHEMA_ERROR], status: 401, detail: 'Invalid SCIM token' }, 401, {
        'www-authenticate': 'Bearer',
      })
    }
    return null
  }
}
