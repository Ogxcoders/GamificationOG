/** GET /api/admin/auth/me — current session + bootstrap state. */
import { NextRequest } from 'next/server'
import { json, apiError } from '@/lib/api'
import { hasAnyAdmin, ADMIN_SESSION_COOKIE } from '@/lib/admin-auth'
import { authenticateAdminSession } from '@/server/identity/service'

export async function GET(req: NextRequest) {
  try {
    const bootstrapped = await hasAnyAdmin()
    const token = req.cookies.get(ADMIN_SESSION_COOKIE)?.value
    if (!token) return json({ authenticated: false, bootstrapped })
    const admin = await authenticateAdminSession(token)
    if (!admin) return json({ authenticated: false, bootstrapped })
    return json({ authenticated: true, bootstrapped, admin })
  } catch (e) {
    return apiError(e)
  }
}
