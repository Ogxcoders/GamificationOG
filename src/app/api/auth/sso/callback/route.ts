/**
 * GET /api/auth/sso/callback?connection=<id>&code=...&state=...
 * Completes the OIDC flow: validates single-use state, exchanges the code
 * (with PKCE verifier + client secret), fetches userinfo, provisions or
 * resolves the admin account, then establishes the dashboard session and
 * redirects home. All failures redirect to /login with a reason code.
 */
import { NextRequest, NextResponse } from 'next/server'
import { consumeFlowState, exchangeCode, fetchUserInfo, loginOrCreateAdminFromOidc } from '@/server/sso/oidc'
import { ADMIN_SESSION_COOKIE } from '@/lib/admin-auth'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const connectionId = url.searchParams.get('connection') ?? ''
  const code = url.searchParams.get('code') ?? ''
  const state = url.searchParams.get('state') ?? ''
  const errorParam = url.searchParams.get('error')

  const fail = (reason: string) => NextResponse.redirect(new URL(`/login?error=${reason}`, url.origin), { status: 302 })

  if (errorParam) return fail(`sso_${errorParam}`)
  if (!connectionId || !code || !state) return fail('sso_callback_invalid')

  try {
    const flow = await consumeFlowState(state)
    // the flow must belong to the same connection and the exact redirect URI
    if (flow.connectionId !== connectionId) return fail('sso_connection_mismatch')
    const expectedRedirect = `${url.origin}/api/auth/sso/callback?connection=${encodeURIComponent(connectionId)}`
    if (flow.redirectUri !== expectedRedirect) return fail('sso_redirect_mismatch')

    const { accessToken } = await exchangeCode(connectionId, code, flow)
    const userinfo = await fetchUserInfo(connectionId, accessToken)
    const conn = await import('@/lib/db').then(({ db }) => db.ssoConnection.findUnique({ where: { id: connectionId } }))
    if (!conn) return fail('sso_connection_not_found')

    const { session, provisioned } = await loginOrCreateAdminFromOidc(
      { id: conn.id, jitEnabled: conn.jitEnabled, jitRole: conn.jitRole, name: conn.name },
      userinfo,
      { ip: req.headers.get('x-forwarded-for') ?? undefined, userAgent: req.headers.get('user-agent') ?? undefined },
    )

    const res = NextResponse.redirect(
      new URL(flow.returnTo && flow.returnTo.startsWith('/') ? flow.returnTo : '/', url.origin),
      { status: 302 },
    )
    const isHttps = url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https'
    res.cookies.set(ADMIN_SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isHttps,
      path: '/',
      maxAge: 7 * 86400,
    })
    return res
  } catch (e) {
    const code_ = (e as { code?: string })?.code ?? 'sso_login_failed'
    return fail(code_.toLowerCase())
  }
}
