/** GET /api/mock-idp/.well-known/openid-configuration — discovery document */
import { NextRequest, NextResponse } from 'next/server'
import { discoveryDoc, mockIdpEnabled, disabledResponse } from '@/server/sso/mock-idp'

export async function GET(req: NextRequest) {
  if (!mockIdpEnabled()) return disabledResponse()
  return NextResponse.json(discoveryDoc(new URL(req.url).origin))
}
