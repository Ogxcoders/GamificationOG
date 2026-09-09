/**
 * GamificationOG — Pack API (Section 57).
 *
 * GET  /api/admin/packs                 — catalog with install state
 * POST /api/admin/packs { slug, action } — action: preview | install | uninstall
 *
 * Session-authenticated (admin console). Installs are audited; objects
 * go through the same resource validators as manual creation.
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { listPacks, previewPack, installPack, uninstallPack } from '@/server/packs/service'
import { PlatformError } from '@/server/core/errors'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const packs = await listPacks({ projectId: scope.projectId, environmentId: scope.environmentId })
    return json({ packs, scope: { projectName: scope.projectName, environmentName: scope.environmentName } })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const body = await readJson<{ slug?: string; action?: string }>(req)

    if (!body.slug || !body.action) {
      throw new PlatformError({
        code: 'FIELD_REQUIRED',
        category: 'validation',
        message: 'Both "slug" and "action" are required.',
        fix: 'action must be one of: preview, install, uninstall.',
      })
    }

    const packScope = { projectId: scope.projectId, environmentId: scope.environmentId }

    switch (body.action) {
      case 'preview':
        return json({ preview: await previewPack(body.slug, packScope) })
      case 'install':
        return json({ result: await installPack(body.slug, packScope, admin.adminUserId) }, 201)
      case 'uninstall':
        return json({ result: await uninstallPack(body.slug, packScope, admin.adminUserId) })
      default:
        throw new PlatformError({
          code: 'INVALID_ACTION',
          category: 'validation',
          message: `Unknown action "${body.action}".`,
          fix: 'action must be one of: preview, install, uninstall.',
        })
    }
  } catch (e) {
    return apiError(e)
  }
}
