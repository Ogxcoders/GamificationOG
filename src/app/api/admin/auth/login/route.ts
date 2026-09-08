/** POST /api/admin/auth/login */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { verifyPassword, createAdminSession } from '@/server/identity/service'
import { ADMIN_SESSION_COOKIE } from '@/lib/admin-auth'
import { PlatformError } from '@/server/core/errors'
import { recordAudit } from '@/server/audit/service'

export async function POST(req: NextRequest) {
  try {
    const body = await readJson<{ email: string; password: string }>(req)
    const user = await db.adminUser.findUnique({ where: { email: (body.email ?? '').toLowerCase() } })
    if (!user || !verifyPassword(body.password ?? '', user.passwordHash)) {
      throw new PlatformError({
        code: 'INVALID_CREDENTIALS',
        category: 'auth',
        message: 'Invalid email or password.',
      })
    }
    if (user.status !== 'active') {
      throw new PlatformError({
        code: 'ACCOUNT_DISABLED',
        category: 'auth',
        message: `Account is ${user.status}.`,
      })
    }
    const session = await createAdminSession({
      userId: user.id,
      ip: req.headers.get('x-forwarded-for') ?? undefined,
      userAgent: req.headers.get('user-agent') ?? undefined,
    })
    await recordAudit({
      projectId: 'global',
      actorType: 'human',
      actorId: user.id,
      action: 'admin.login',
      targetType: 'admin_user',
      targetId: user.id,
    })
    const res = json({ ok: true, email: user.email, name: user.name, role: user.role })
    res.cookies.set(ADMIN_SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 86400,
    })
    return res
  } catch (e) {
    return apiError(e)
  }
}
