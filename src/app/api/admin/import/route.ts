/**
 * GamificationOG — Import API (Section 60).
 * POST /api/admin/import { package, mode?, strategy? }
 *   mode:     'dry-run' (default) — validation + diff + conflict preview
 *             'apply'            — transactional import
 *   strategy: 'skip' (default) | 'overwrite'
 *
 * Session-authenticated (admin console only). Every apply is audited.
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { previewImport, applyImport, type ImportStrategy } from '@/server/io/importer'
import { PlatformError } from '@/server/core/errors'

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const body = await readJson<{ package?: unknown; mode?: string; strategy?: string }>(req)

    if (body.package === undefined) {
      throw new PlatformError({
        code: 'FIELD_REQUIRED',
        category: 'validation',
        message: 'Field "package" is required (the exported JSON object).',
        fix: 'Export a package via GET /api/admin/export and post it back.',
      })
    }

    const strategy: ImportStrategy = body.strategy === 'overwrite' ? 'overwrite' : 'skip'
    const importScope = { projectId: scope.projectId, environmentId: scope.environmentId }

    if (body.mode === 'apply') {
      const result = await applyImport(body.package, importScope, strategy, admin.adminUserId)
      return json({ result })
    }

    const preview = await previewImport(body.package, importScope, strategy)
    return json({ preview })
  } catch (e) {
    return apiError(e)
  }
}
