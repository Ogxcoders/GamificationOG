/**
 * Mock IdP authorize endpoint.
 * GET  — renders the login form (realistic user-agent step)
 * POST — validates credentials + params, mints a single-use code,
 *        302s back to the relying party's redirect_uri.
 */
import { NextRequest, NextResponse } from 'next/server'
import { mockIdpEnabled, disabledResponse, issueCode, verifyPassword, MOCK_IDP_USER } from '@/server/sso/mock-idp'

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function GET(req: NextRequest) {
  if (!mockIdpEnabled()) return disabledResponse()
  const url = new URL(req.url)
  const params = url.searchParams
  const clientId = params.get('client_id') ?? ''
  const redirectUri = params.get('redirect_uri') ?? ''
  const state = params.get('state') ?? ''
  const codeChallenge = params.get('code_challenge') ?? ''
  const method = params.get('code_challenge_method') ?? ''

  const missing = ['client_id', 'redirect_uri', 'state', 'code_challenge'].filter((k) => !params.get(k))
  const html = `<!DOCTYPE html>
<html><head><title>Mock IdP — Sign in</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.card{background:#1e293b;padding:2rem 2.5rem;border-radius:12px;max-width:380px}
input{display:block;width:100%;margin:.5rem 0;padding:.5rem;border-radius:6px;border:1px solid #475569;background:#0f172a;color:inherit}
button{width:100%;margin-top:1rem;padding:.6rem;border:none;border-radius:6px;background:#6366f1;color:#fff;font-weight:600;cursor:pointer}
.hint{color:#94a3b8;font-size:.8rem;margin-top:1rem}</style></head>
<body><form class="card" method="POST" action="/api/mock-idp/authorize">
<h2>Mock OIDC Provider</h2>
<input name="username" placeholder="username" value="${escapeHtml(MOCK_IDP_USER.username)}" />
<input name="password" type="password" placeholder="password" />
<input type="hidden" name="client_id" value="${escapeHtml(clientId)}" />
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}" />
<input type="hidden" name="state" value="${escapeHtml(state)}" />
<input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}" />
<input type="hidden" name="code_challenge_method" value="${escapeHtml(method)}" />
<button type="submit">Sign in</button>
${missing.length ? `<p class="hint">⚠ missing params: ${missing.join(', ')}</p>` : '<p class="hint">Test IdP — dev mode only</p>'}
</form></body></html>`
  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

export async function POST(req: NextRequest) {
  if (!mockIdpEnabled()) return disabledResponse()
  const url = new URL(req.url)
  let clientId = ''
  let redirectUri = ''
  let state = ''
  let codeChallenge = ''
  let username = ''
  let password = ''
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    const body = (await req.json()) as Record<string, string>
    clientId = body.client_id ?? ''
    redirectUri = body.redirect_uri ?? ''
    state = body.state ?? ''
    codeChallenge = body.code_challenge ?? ''
    username = body.username ?? ''
    password = body.password ?? ''
  } else {
    const form = new URLSearchParams(await req.text())
    clientId = form.get('client_id') ?? ''
    redirectUri = form.get('redirect_uri') ?? ''
    state = form.get('state') ?? ''
    codeChallenge = form.get('code_challenge') ?? ''
    username = form.get('username') ?? ''
    password = form.get('password') ?? ''
  }

  const fail = (error: string, description: string) =>
    NextResponse.json({ error, error_description: description }, { status: 400 })

  if (!clientId || !redirectUri || !codeChallenge) return fail('invalid_request', 'client_id, redirect_uri and code_challenge are required')
  if (!verifyPassword(username, password)) return fail('access_denied', 'invalid mock credentials (use ada@example.com / mock-idp-secret)')

  const code = issueCode({ clientId, redirectUri, codeChallenge, sub: MOCK_IDP_USER.sub })
  const back = new URL(redirectUri)
  if (state) back.searchParams.set('state', state)
  back.searchParams.set('code', code)
  return NextResponse.redirect(back, { status: 302 })
}
