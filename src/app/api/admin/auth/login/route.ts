/** POST /api/admin/auth/login — hardened: attempt throttling + failure audit (§ Advanced security) */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { verifyPassword, createAdminSession } from '@/server/identity/service'
import { ADMIN_SESSION_COOKIE } from '@/lib/admin-auth'
import { PlatformError } from '@/server/core/errors'
import { recordAudit } from '@/server/audit/service'
import { clientIp, loginLockedFor, recordLoginFailure, clearLoginFailures } from '@/server/security/rate-limit'

export async function POST(req: NextRequest) {
  const ip = clientIp(req)
  let email = ''
  try {
    const body = await readJson<{ email: string; password: string }>(req)
    email = (body.email ?? '').toLowerCase()
    const throttleKey = `${ip}:${email}`

    // Brute-force lockout (checked before touching the database)
    const locked = loginLockedFor(throttleKey)
    if (locked > 0) {
      throw new PlatformError({
        code: 'LOGIN_LOCKED',
        category: 'rate_limit',
        message: `Too many failed sign-in attempts. Try again in ${locked} seconds.`,
        status: 429,
        headers: { 'retry-after': String(locked) },
      })
    }

    const user = await db.adminUser.findUnique({ where: { email } })
    if (!user || !verifyPassword(body.password ?? '', user.passwordHash)) {
      recordLoginFailure(throttleKey)
      await recordAudit({
        projectId: 'global',
        actorType: 'system',
        actorId: 'auth-gateway',
        action: 'admin.login_failed',
        targetType: 'admin_user',
        targetId: email,
      }).catch(() => null)
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
    clearLoginFailures(throttleKey)
    await recordAudit({
      projectId: 'global',
      actorType: 'human',
      actorId: user.id,
      action: 'admin.login',
      targetType: 'admin_user',
      targetId: user.id,
    })
    const res = json({ ok: true, email: user.email, name: user.name, role: user.role })
    const isHttps = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https'
    res.cookies.set(ADMIN_SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isHttps,
      path: '/',
      maxAge: 7 * 86400,
    })
    return res
  } catch (e) {
    return apiError(e)
  }
}
