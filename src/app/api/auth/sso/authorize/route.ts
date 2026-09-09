/**
 * GET /api/auth/sso/authorize?connection=<id> — begin OIDC Authorization
 * Code flow. 302 to the IdP's authorization endpoint with state, nonce and
 * PKCE S256. The browser lands back on /api/auth/sso/callback.
 */
import { NextRequest, NextResponse } from 'next/server'
import { startSsoFlow } from '@/server/sso/oidc'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const connectionId = url.searchParams.get('connection') ?? ''
  const returnTo = url.searchParams.get('returnTo') ?? undefined

  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/login?error=${reason}`, url.origin), { status: 302 })

  if (!connectionId) return fail('sso_connection_required')
  const redirectUri = `${url.origin}/api/auth/sso/callback?connection=${encodeURIComponent(connectionId)}`
  try {
    const flow = await startSsoFlow(connectionId, redirectUri, returnTo)
    return NextResponse.redirect(flow.authorizationUrl, { status: 302 })
  } catch {
    return fail('sso_start_failed')
  }
}
