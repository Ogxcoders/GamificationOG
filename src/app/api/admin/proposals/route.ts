/**
 * GamificationOG — Admin Proposal Queue (Sections 66-67).
 * GET /api/admin/proposals?status= — the human approval queue.
 * Session-authenticated. Decisions happen in the [id]/decide route.
 */
import { NextRequest } from 'next/server'
import { json, apiError } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { listProposals, PROPOSAL_RESOURCE_MAP } from '@/server/proposals/service'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const status = new URL(req.url).searchParams.get('status') ?? undefined
    const proposals = await listProposals(
      { projectId: scope.projectId, environmentId: scope.environmentId },
      status,
    )
    return json({
      proposals,
      counts: {
        pending: proposals.filter((p) => p.status === 'pending').length,
        total: proposals.length,
      },
      supportedTypes: Object.keys(PROPOSAL_RESOURCE_MAP),
      scope: { projectName: scope.projectName, environmentName: scope.environmentName },
    })
  } catch (e) {
    return apiError(e)
  }
}
