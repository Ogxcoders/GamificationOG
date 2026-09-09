/**
 * GamificationOG — SSO/OIDC service (§9, Phase 5)
 * Enterprise single sign-on: standards-compliant OIDC Authorization Code
 * flow with PKCE (S256), single-use state, discovery, and just-in-time
 * admin provisioning with explicit per-connection role policy.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'
import { parseJson } from '@/server/core/types'
import { createAdminSession, hashPassword } from '@/server/identity/service'
import { recordAudit } from '@/server/audit/service'

// ---------------------------------------------------------------------------
// Client-secret encryption at rest (AES-256-GCM, key derived from env)
// ---------------------------------------------------------------------------

function encryptionKey(): Buffer {
  const secret = process.env.GOG_SSO_SECRET ?? process.env.AUTH_SECRET ?? 'gog-dev-sso-secret-change-me'
  // scrypt-derive a stable 32-byte key from the configured secret
  return scryptSync(secret, 'gog-sso-encryption', 32)
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}.${tag.toString('base64url')}`
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith('v1.')) return stored // legacy/plain fallback
  const [, ivB, dataB, tagB] = stored.split('.')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64url')), decipher.final()]).toString('utf8')
}

// ---------------------------------------------------------------------------
// OIDC provider discovery (cached 10 minutes)
// ---------------------------------------------------------------------------

export interface OidcEndpoints {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  issuer: string
}

const discoveryCache = new Map<string, { endpoints: OidcEndpoints; fetchedAt: number }>()
const DISCOVERY_TTL = 10 * 60_000

export async function discoverEndpoints(issuer: string): Promise<OidcEndpoints> {
  const cached = discoveryCache.get(issuer)
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL) return cached.endpoints
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) {
    throw new PlatformError({
      code: 'SSO_DISCOVERY_FAILED',
      category: 'auth',
      message: `OIDC discovery failed for issuer "${issuer}" (${res.status}).`,
      fix: 'Verify the issuer URL and that it exposes /.well-known/openid-configuration.',
    })
  }
  const doc = (await res.json()) as Partial<OidcEndpoints>
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new PlatformError({
      code: 'SSO_DISCOVERY_INVALID',
      category: 'auth',
      message: 'OIDC discovery document is missing authorization/token endpoints.',
    })
  }
  const endpoints: OidcEndpoints = {
    issuer: doc.issuer ?? issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    userinfo_endpoint: doc.userinfo_endpoint ?? '',
  }
  discoveryCache.set(issuer, { endpoints, fetchedAt: Date.now() })
  return endpoints
}

// ---------------------------------------------------------------------------
// Flow state (single-use, 10 minute TTL)
// ---------------------------------------------------------------------------

export interface StartedFlow {
  state: string
  nonce: string
  codeVerifier: string
  authorizationUrl: string
}

export function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

export async function startSsoFlow(connectionId: string, redirectUri: string, returnTo?: string): Promise<StartedFlow> {
  const conn = await db.ssoConnection.findUnique({ where: { id: connectionId } })
  if (!conn || conn.status !== 'active') {
    throw new PlatformError({
      code: 'SSO_CONNECTION_NOT_FOUND',
      category: 'not_found',
      message: 'SSO connection not found or disabled.',
      status: 404,
    })
  }
  const endpoints = await discoverEndpoints(conn.issuer)
  const state = b64url(randomBytes(24))
  const nonce = b64url(randomBytes(16))
  const codeVerifier = b64url(randomBytes(32))
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest())

  await db.ssoFlowState.create({
    data: {
      connectionId,
      state,
      nonce,
      codeVerifier,
      redirectUri,
      returnTo: returnTo ?? null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  })

  const scopes = parseJson<string[]>(conn.scopesJson, ['openid', 'email', 'profile'])
  const authUrl = new URL(endpoints.authorization_endpoint)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', conn.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', scopes.join(' '))
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('nonce', nonce)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')

  return { state, nonce, codeVerifier, authorizationUrl: authUrl.toString() }
}

export async function consumeFlowState(state: string) {
  const flow = await db.ssoFlowState.findUnique({ where: { state } })
  if (!flow) {
    throw new PlatformError({
      code: 'SSO_STATE_INVALID',
      category: 'auth',
      message: 'Unknown SSO state (it may have been used already).',
      fix: 'Restart the sign-in flow from the login page.',
    })
  }
  // single-use: delete immediately regardless of outcome
  await db.ssoFlowState.delete({ where: { id: flow.id } })
  if (flow.expiresAt < new Date()) {
    throw new PlatformError({ code: 'SSO_STATE_EXPIRED', category: 'auth', message: 'SSO state expired. Restart sign-in.' })
  }
  return flow
}

// ---------------------------------------------------------------------------
// Code exchange + userinfo
// ---------------------------------------------------------------------------

export async function exchangeCode(connectionId: string, code: string, flow: { codeVerifier: string; redirectUri: string }): Promise<{ accessToken: string }> {
  const conn = await db.ssoConnection.findUnique({ where: { id: connectionId } })
  if (!conn) throw new PlatformError({ code: 'SSO_CONNECTION_NOT_FOUND', category: 'not_found', message: 'SSO connection not found.', status: 404 })
  const endpoints = await discoverEndpoints(conn.issuer)

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: flow.redirectUri,
    client_id: conn.clientId,
    client_secret: decryptSecret(conn.clientSecret),
    code_verifier: flow.codeVerifier,
  })
  const res = await fetch(endpoints.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new PlatformError({
      code: 'SSO_TOKEN_EXCHANGE_FAILED',
      category: 'auth',
      message: `OIDC token exchange failed (${res.status}).`,
      detail: detail.slice(0, 300),
    })
  }
  const tok = (await res.json()) as { access_token?: string }
  if (!tok.access_token) {
    throw new PlatformError({ code: 'SSO_TOKEN_MISSING', category: 'auth', message: 'Token response missing access_token.' })
  }
  return { accessToken: tok.access_token }
}

export interface OidcUserInfo {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
}

export async function fetchUserInfo(connectionId: string, accessToken: string): Promise<OidcUserInfo> {
  const conn = await db.ssoConnection.findUnique({ where: { id: connectionId } })
  if (!conn) throw new PlatformError({ code: 'SSO_CONNECTION_NOT_FOUND', category: 'not_found', message: 'SSO connection not found.', status: 404 })
  const endpoints = await discoverEndpoints(conn.issuer)
  if (!endpoints.userinfo_endpoint) {
    throw new PlatformError({ code: 'SSO_NO_USERINFO', category: 'auth', message: 'OIDC provider does not expose a userinfo endpoint.' })
  }
  const res = await fetch(endpoints.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  })
  if (!res.ok) {
    throw new PlatformError({ code: 'SSO_USERINFO_FAILED', category: 'auth', message: `OIDC userinfo call failed (${res.status}).` })
  }
  const info = (await res.json()) as OidcUserInfo
  if (!info.sub || !info.email) {
    throw new PlatformError({
      code: 'SSO_CLAIMS_MISSING',
      category: 'auth',
      message: 'OIDC userinfo is missing the "sub" or "email" claim (required for dashboard identity).',
      fix: 'Request the "email" scope and ensure the IdP releases email claims.',
    })
  }
  return info
}

// ---------------------------------------------------------------------------
// Admin find-or-provision + session
// ---------------------------------------------------------------------------

export async function loginOrCreateAdminFromOidc(
  conn: { id: string; jitEnabled: boolean; jitRole: string; name: string },
  userinfo: OidcUserInfo,
  ctx: { ip?: string; userAgent?: string },
) {
  const email = userinfo.email!.toLowerCase()
  let user = await db.adminUser.findUnique({ where: { email } })
  let provisioned = false

  if (!user) {
    if (!conn.jitEnabled) {
      throw new PlatformError({
        code: 'SSO_JIT_DISABLED',
        category: 'auth',
        message: `No dashboard account exists for "${email}" and JIT provisioning is disabled for this connection.`,
        fix: 'Ask an owner to create the account first (or enable provisioning on the SSO connection).',
      })
    }
    user = await db.adminUser.create({
      data: {
        email,
        name: userinfo.name ?? email.split('@')[0],
        // random unusable password: SSO-only account
        passwordHash: hashPassword(b64url(randomBytes(32))),
        role: conn.jitRole,
        status: 'active',
      },
    })
    provisioned = true
    await recordAudit({
      projectId: 'global',
      actorType: 'system',
      actorId: `sso:${conn.id}`,
      action: 'sso.user_provisioned',
      targetType: 'admin_user',
      targetId: user.id,
      afterJson: JSON.stringify({ email, role: user.role, connection: conn.name }),
    })
  }

  if (user.status !== 'active') {
    throw new PlatformError({ code: 'ACCOUNT_DISABLED', category: 'auth', message: `Account is ${user.status}.` })
  }

  const session = await createAdminSession({ userId: user.id, ip: ctx.ip, userAgent: ctx.userAgent })
  await recordAudit({
    projectId: 'global',
    actorType: 'human',
    actorId: user.id,
    action: 'sso.login',
    targetType: 'sso_connection',
    targetId: conn.id,
    afterJson: JSON.stringify({ email, provisioned }),
  })
  return { session, user, provisioned }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
