/** POST /api/admin/auth/logout */
import { NextRequest } from 'next/server'
import { json, apiError } from '@/lib/api'
import { destroyAdminSession } from '@/server/identity/service'
import { ADMIN_SESSION_COOKIE } from '@/lib/admin-auth'

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(ADMIN_SESSION_COOKIE)?.value
    if (token) await destroyAdminSession(token)
    const res = json({ ok: true })
    res.cookies.set(ADMIN_SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
    return res
  } catch (e) {
    return apiError(e)
  }
}
