/** GET /api/scim/v2/ServiceProviderConfig — capability discovery (RFC 7644 §4). */
import { NextRequest } from 'next/server'
import { serviceProviderConfig } from '@/server/scim/service'
import { scimJson, scimErrorResponse, requireScimAuth } from '@/server/scim/http'

const auth = requireScimAuth()

export async function GET(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied
  try {
    return scimJson(serviceProviderConfig())
  } catch (e) {
    return scimErrorResponse(e)
  }
}
