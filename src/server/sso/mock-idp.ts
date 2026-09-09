/**
 * GamificationOG — Mock OIDC Identity Provider (DEV/TEST ONLY).
 *
 * A self-contained, spec-shaped OIDC provider used for e2e tests and local
 * demos of the SSO flow without an external IdP:
 *   GET  /api/mock-idp/.well-known/openid-configuration
 *   GET  /api/mock-idp/authorize  -> HTML login form (auto-submit)
 *   POST /api/mock-idp/authorize  -> 302 back to redirect_uri?code&state
 *   POST /api/mock-idp/token      -> { access_token } (validates PKCE S256)
 *   GET  /api/mock-idp/userinfo   -> subject claims
 *
 * Mock user: ada@example.com / mock-idp-secret
 *
 * DISABLED in production unless GOG_ALLOW_MOCK_IDP=true (never enable on
 * internet-facing deployments — it would let anyone mint dashboard sessions).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'

export const MOCK_IDP_USER = { username: 'ada@example.com', password: 'mock-idp-secret', name: 'Ada Lovelace', sub: 'mock-idp-ada-001' }

// single-use authorization codes: code -> binding
const codes = new Map<string, { clientId: string; redirectUri: string; codeChallenge: string; sub: string; expiresAt: number }>()
// bearer tokens: token -> claims
const tokens = new Map<string, { sub: string; email: string; name: string; expiresAt: number }>()

export function mockIdpEnabled(): boolean {
  if (process.env.NODE_ENV === 'production' && process.env.GOG_ALLOW_MOCK_IDP !== 'true') return false
  return true
}

export function disabledResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: 'MOCK_IDP_DISABLED', category: 'auth', message: 'Mock IdP is disabled (production mode).' } },
    { status: 404 },
  )
}

export function issueCode(binding: { clientId: string; redirectUri: string; codeChallenge: string; sub: string }): string {
  const code = randomBytes(24).toString('base64url')
  codes.set(code, { ...binding, expiresAt: Date.now() + 60_000 })
  return code
}

export function takeCode(code: string) {
  const rec = codes.get(code)
  codes.delete(code) // single use
  if (!rec || rec.expiresAt < Date.now()) return null
  return rec
}

export function issueToken(claims: { sub: string; email: string; name: string }): string {
  const token = randomBytes(32).toString('base64url')
  tokens.set(token, { ...claims, expiresAt: Date.now() + 120_000 })
  return token
}

export function takeToken(token: string) {
  const rec = tokens.get(token)
  if (!rec || rec.expiresAt < Date.now()) return null
  return rec
}

export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash('sha256').update(codeVerifier).digest('base64url')
  const a = Buffer.from(computed)
  const b = Buffer.from(codeChallenge)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function verifyPassword(username: string, password: string): boolean {
  const u = Buffer.from(username)
  const eu = Buffer.from(MOCK_IDP_USER.username)
  const p = Buffer.from(password)
  const ep = Buffer.from(MOCK_IDP_USER.password)
  return u.length === eu.length && timingSafeEqual(u, eu) && p.length === ep.length && timingSafeEqual(p, ep)
}

/** healthcheck-ish discovery */
export function discoveryDoc(origin: string) {
  const base = `${origin}/api/mock-idp`
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    userinfo_endpoint: `${base}/userinfo`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['none'],
    scopes_supported: ['openid', 'email', 'profile'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: ['sub', 'email', 'email_verified', 'name'],
  }
}
