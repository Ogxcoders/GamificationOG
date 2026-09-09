/**
 * GET /api/auth/sso/connections — PUBLIC list of active SSO connections
 * for the login page. Exposes only id + name (+ hint domains); never
 * client ids, secrets, or issuer URLs.
 */
import { NextRequest } from 'next/server'
import { json, apiError } from '@/lib/api'
import { db } from '@/lib/db'

export async function GET(_req: NextRequest) {
  try {
    const connections = await db.ssoConnection.findMany({
      where: { status: 'active' },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    })
    return json({ connections })
  } catch (e) {
    return apiError(e)
  }
}
