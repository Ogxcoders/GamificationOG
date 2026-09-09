/**
 * GamificationOG — Export API (Section 59).
 * GET /api/admin/export — download the gamification system as a portable
 * JSON package (manifest + resources keyed by natural keys).
 * Session-authenticated (admin console only).
 */
import { NextRequest } from 'next/server'
import { json, apiError } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { exportGamificationSystem } from '@/server/io/exporter'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const pkg = await exportGamificationSystem({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      projectName: scope.projectName,
      environmentName: scope.environmentName,
    })

    const download = new URL(req.url).searchParams.get('download') === '1'
    const filename = `gamification-${scope.projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${scope.environmentName}-${new Date().toISOString().slice(0, 10)}.json`

    const response = json(pkg)
    if (download) {
      // Content-Disposition with the typed JSON envelope (see lib/api json())
      return new Response(JSON.stringify(pkg), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-disposition': `attachment; filename="${filename}"`,
        },
      })
    }
    return response
  } catch (e) {
    return apiError(e)
  }
}
