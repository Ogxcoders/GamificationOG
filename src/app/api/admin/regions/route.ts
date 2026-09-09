/**
 * Region administration (§ Phase 5 data residency).
 * GET  — region registry + project pinning report
 * PUT  — pin the current scope's project to a region (?code=eu)
 */
import { NextRequest } from 'next/server'
import { json, apiError } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { regionReport, setProjectDataRegion, listRegions } from '@/server/regions/service'
import { recordAudit } from '@/server/audit/service'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const url = new URL(req.url)
    if (url.searchParams.get('report') === '1') {
      return json(await regionReport())
    }
    const regions = await listRegions()
    return json({ regions })
  } catch (e) {
    return apiError(e)
  }
}

export async function PUT(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    if (!code) {
      return json({ error: { code: 'CODE_REQUIRED', message: 'Query param code (region) required.' } }, 400)
    }
    const result = await setProjectDataRegion({
      projectId: scope.projectId,
      region: code,
      actorId: admin.adminUserId,
    })
    await recordAudit({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      actorType: 'human',
      actorId: admin.adminUserId,
      action: 'region.project_pinned',
      targetType: 'project',
      targetId: scope.projectId,
      afterJson: JSON.stringify(result),
    })
    return json(result)
  } catch (e) {
    return apiError(e)
  }
}
