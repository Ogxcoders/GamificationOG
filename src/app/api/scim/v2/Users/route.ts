/** SCIM /Users collection — GET (list/filter), POST (create). */
import { NextRequest } from 'next/server'
import { listScimUsers, createScimUser } from '@/server/scim/service'
import { scimJson, scimErrorResponse, requireScimAuth } from '@/server/scim/http'

const auth = requireScimAuth()

export async function GET(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied
  try {
    const url = new URL(req.url)
    const list = await listScimUsers({
      filter: url.searchParams.get('filter') ?? undefined,
      startIndex: Math.max(1, Number(url.searchParams.get('startIndex') ?? 1) || 1),
      count: Math.min(200, Math.max(1, Number(url.searchParams.get('count') ?? 100) || 100)),
    })
    return scimJson(list)
  } catch (e) {
    return scimErrorResponse(e)
  }
}

export async function POST(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied
  try {
    const body = (await req.json()) as {
      userName?: string
      displayName?: string
      active?: boolean
      role?: string
    }
    const user = await createScimUser({
      userName: body.userName ?? '',
      displayName: body.displayName,
      active: body.active,
      role: body.role,
    })
    return scimJson(user, 201, { location: `/api/scim/v2/Users/${(user as { id: string }).id}` })
  } catch (e) {
    return scimErrorResponse(e)
  }
}
