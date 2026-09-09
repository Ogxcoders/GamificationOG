/** SCIM /Groups collection — GET (list), POST (create project-access group). */
import { NextRequest } from 'next/server'
import { listScimGroups, createScimGroup } from '@/server/scim/service'
import { scimJson, scimErrorResponse, requireScimAuth } from '@/server/scim/http'

const auth = requireScimAuth()

export async function GET(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied
  try {
    const url = new URL(req.url)
    const list = await listScimGroups(
      Math.max(1, Number(url.searchParams.get('startIndex') ?? 1) || 1),
      Math.min(200, Math.max(1, Number(url.searchParams.get('count') ?? 100) || 100)),
    )
    return scimJson(list)
  } catch (e) {
    return scimErrorResponse(e)
  }
}

export async function POST(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied
  try {
    const body = (await req.json()) as { displayName?: string; members?: Array<{ value: string }> }
    const group = await createScimGroup({ displayName: body.displayName ?? '', members: body.members })
    return scimJson(group, 201, { location: `/api/scim/v2/Groups/${(group as { id: string }).id}` })
  } catch (e) {
    return scimErrorResponse(e)
  }
}
