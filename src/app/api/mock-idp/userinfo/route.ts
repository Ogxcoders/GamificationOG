/** GET /api/mock-idp/userinfo — subject claims for a valid bearer token. */
import { NextRequest, NextResponse } from 'next/server'
import { mockIdpEnabled, disabledResponse, takeToken } from '@/server/sso/mock-idp'

export async function GET(req: NextRequest) {
  if (!mockIdpEnabled()) return disabledResponse()
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const claims = takeToken(token)
  if (!claims) {
    return NextResponse.json(
      { error: 'invalid_token', error_description: 'token is missing, expired or invalid' },
      { status: 401 },
    )
  }
  return NextResponse.json({
    sub: claims.sub,
    email: claims.email,
    email_verified: true,
    name: claims.name,
  })
}
