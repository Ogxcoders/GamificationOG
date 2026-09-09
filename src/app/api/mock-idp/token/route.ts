/**
 * POST /api/mock-idp/token — token endpoint (client_secret_post + PKCE S256).
 * Validates grant_type, code (single-use), client credentials, redirect_uri
 * and the PKCE code_verifier exactly like a conformant IdP would.
 */
import { NextRequest, NextResponse } from 'next/server'
import { mockIdpEnabled, disabledResponse, takeCode, issueToken, verifyPkce, MOCK_IDP_USER } from '@/server/sso/mock-idp'

export async function POST(req: NextRequest) {
  if (!mockIdpEnabled()) return disabledResponse()
  const form = new URLSearchParams(await req.text())
  const grantType = form.get('grant_type') ?? ''
  const code = form.get('code') ?? ''
  const clientId = form.get('client_id') ?? ''
  const clientSecret = form.get('client_secret') ?? ''
  const redirectUri = form.get('redirect_uri') ?? ''
  const codeVerifier = form.get('code_verifier') ?? ''

  const fail = (error: string, description: string) =>
    NextResponse.json({ error, error_description: description }, { status: 400 })

  if (grantType !== 'authorization_code') return fail('unsupported_grant_type', 'only authorization_code is supported')
  const binding = takeCode(code)
  if (!binding) return fail('invalid_grant', 'code is unknown, expired or already used')
  if (binding.clientId !== clientId) return fail('invalid_client', 'client_id does not match the authorization request')
  if (binding.redirectUri !== redirectUri) return fail('invalid_grant', 'redirect_uri does not match the authorization request')
  // mock IdP client registry: client_secret must equal "mock-idp-client-secret"
  if (clientSecret !== 'mock-idp-client-secret') return fail('invalid_client', 'client_secret is invalid')
  if (!codeVerifier || !verifyPkce(codeVerifier, binding.codeChallenge)) return fail('invalid_grant', 'PKCE code_verifier does not match code_challenge')

  const access_token = issueToken({ sub: binding.sub, email: MOCK_IDP_USER.username, name: MOCK_IDP_USER.name })
  return NextResponse.json({
    access_token,
    token_type: 'Bearer',
    expires_in: 120,
    scope: 'openid email profile',
  })
}
