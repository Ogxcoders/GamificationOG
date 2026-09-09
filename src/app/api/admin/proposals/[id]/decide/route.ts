/**
 * GamificationOG — Proposal Decision (Sections 66-67).
 * POST /api/admin/proposals/[id]/decide { decision: 'approve'|'reject', note? }
 *
 * Human-only (admin session — API keys can NEVER decide). Approve executes
 * the proposal through the same validated create path with an 'ai' audit
 * actor; reject closes it without side effects.
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { decideProposal } from '@/server/proposals/service'
import { PlatformError } from '@/server/core/errors'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const { id } = await params
    const body = await readJson<{ decision?: string; note?: string }>(req)

    if (body.decision !== 'approve' && body.decision !== 'reject') {
      throw new PlatformError({
        code: 'INVALID_DECISION',
        category: 'validation',
        message: `"decision" must be "approve" or "reject".`,
      })
    }

    const result = await decideProposal(
      id,
      body.decision,
      { projectId: scope.projectId, environmentId: scope.environmentId },
      admin.adminUserId,
      body.note,
    )
    return json({ result })
  } catch (e) {
    return apiError(e)
  }
}
