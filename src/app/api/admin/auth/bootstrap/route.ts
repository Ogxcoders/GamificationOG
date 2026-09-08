/** POST /api/admin/auth/bootstrap — create the owner account (only when none exists). */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { hashPassword, createAdminSession } from '@/server/identity/service'
import { hasAnyAdmin, ADMIN_SESSION_COOKIE } from '@/lib/admin-auth'
import { recordAudit } from '@/server/audit/service'
import { PlatformError } from '@/server/core/errors'

export async function POST(req: NextRequest) {
  try {
    if (await hasAnyAdmin()) {
      throw new PlatformError({
        code: 'ALREADY_BOOTSTRAPPED',
        category: 'conflict',
        message: 'An owner account already exists. Log in instead.',
      })
    }
    const body = await readJson<{ email: string; name: string; password: string }>(req)
    if (!body.email || !body.password || body.password.length < 8) {
      throw new PlatformError({
        code: 'INVALID_INPUT',
        category: 'validation',
        message: 'Email and a password of at least 8 characters are required.',
      })
    }
    const user = await db.adminUser.create({
      data: {
        email: body.email.toLowerCase(),
        name: body.name || 'Owner',
        passwordHash: hashPassword(body.password),
        role: 'owner',
      },
    })
    await recordAudit({
      projectId: 'global',
      actorType: 'human',
      actorId: user.id,
      action: 'admin.bootstrapped',
      targetType: 'admin_user',
      targetId: user.id,
    })
    const session = await createAdminSession({ userId: user.id })
    const res = json({ ok: true, email: user.email, name: user.name })
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
