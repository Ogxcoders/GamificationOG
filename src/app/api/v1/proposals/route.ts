/**
 * GamificationOG — AI Proposal API (Sections 66-67, MCP write-tools).
 *
 * POST /api/v1/proposals — submit a configuration change proposal
 *   (scope: rules:propose). Payload is validated at submission; the
 *   proposal is stored pending — a human must approve before execution.
 * GET  /api/v1/proposals?status= — list proposals (scope: rules:propose
 *   or rules:read) so agents can track decisions.
 *
 * AI never receives direct write access — §67 permission levels:
 * read < propose < simulate < write. Write belongs to humans only.
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson, requireApiKey, requireAnyScope } from '@/lib/api'
import { createProposal, listProposals, PROPOSAL_RESOURCE_MAP } from '@/server/proposals/service'
import { PlatformError } from '@/server/core/errors'

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireAnyScope(auth, ['rules:propose', 'rules:read'])
    const scope = { projectId: auth.projectId, environmentId: auth.environmentId }
    const status = new URL(req.url).searchParams.get('status') ?? undefined
    const proposals = await listProposals(scope, status)
    return json({
      proposals,
      counts: {
        pending: proposals.filter((p) => p.status === 'pending').length,
        total: proposals.length,
      },
      supportedTypes: Object.keys(PROPOSAL_RESOURCE_MAP),
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireAnyScope(auth, ['rules:propose'])
    const body = await readJson<{ type?: string; payload?: Record<string, unknown>; rationale?: string }>(req)

    if (!body.type || !body.payload || typeof body.payload !== 'object') {
      throw new PlatformError({
        code: 'FIELD_REQUIRED',
        category: 'validation',
        message: 'Fields "type" and "payload" are required.',
        fix: `type must be one of: ${Object.keys(PROPOSAL_RESOURCE_MAP).join(', ')}; payload is the proposed configuration object.`,
      })
    }

    const result = await createProposal(
      {
        type: body.type,
        payload: body.payload,
        rationale: body.rationale,
        proposedByKeyId: auth.apiKeyId,
      },
      { projectId: auth.projectId, environmentId: auth.environmentId },
    )
    return json(result, 201)
  } catch (e) {
    return apiError(e)
  }
}
