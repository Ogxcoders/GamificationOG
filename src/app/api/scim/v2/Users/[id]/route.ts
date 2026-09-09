/** SCIM /Users/{id} — GET, PUT (replace), PATCH (RFC 7644), DELETE (deactivate). */
import { NextRequest, NextResponse } from 'next/server'
import { getScimUser, replaceScimUser, patchScimUser, deleteScimUser } from '@/server/scim/service'
import { scimJson, scimErrorResponse, requireScimAuth } from '@/server/scim/http'

const auth = requireScimAuth()

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await auth(req)
  if (denied) return denied
  try {
    const { id } = await params
    return scimJson(await getScimUser(id))
  } catch (e) {
    return scimErrorResponse(e)
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await auth(req)
  if (denied) return denied
  try {
    const { id } = await params
    const body = (await req.json()) as { userName?: string; displayName?: string; active?: boolean; role?: string }
    return scimJson(
      await replaceScimUser(id, {
        userName: body.userName ?? '',
        displayName: body.displayName,
        active: body.active,
        role: body.role,
      }),
    )
  } catch (e) {
    return scimErrorResponse(e)
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await auth(req)
  if (denied) return denied
  try {
    const { id } = await params
    const body = (await req.json()) as { Operations?: Array<{ op: string; path?: string; value?: unknown }> }
    const ops = body.Operations ?? []
    if (!Array.isArray(ops) || ops.length === 0) {
      return scimJson(
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
          status: 400,
          detail: 'Operations array with at least one replace op is required',
        },
        400,
      )
    }
    return scimJson(await patchScimUser(id, ops))
  } catch (e) {
    return scimErrorResponse(e)
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await auth(req)
  if (denied) return denied
  try {
    const { id } = await params
    await deleteScimUser(id)
    return new NextResponse(null, { status: 204 })
  } catch (e) {
    return scimErrorResponse(e)
  }
}
