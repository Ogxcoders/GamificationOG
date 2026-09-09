/** SCIM /Groups/{id} — DELETE removes the project membership. */
import { NextRequest, NextResponse } from 'next/server'
import { deleteScimGroup } from '@/server/scim/service'
import { scimErrorResponse, requireScimAuth } from '@/server/scim/http'

const auth = requireScimAuth()

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await auth(req)
  if (denied) return denied
  try {
    const { id } = await params
    await deleteScimGroup(id)
    return new NextResponse(null, { status: 204 })
  } catch (e) {
    return scimErrorResponse(e)
  }
}
