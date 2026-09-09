/**
 * GamificationOG — Proposal Service (Sections 66-67).
 * AI write-tools never mutate configuration directly: agents submit
 * proposals (validated, scoped rules:propose), humans approve or reject,
 * and execution goes through the same validated create path as manual
 * configuration — fully audited with an 'ai' actor.
 */
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'
import { recordAudit } from '@/server/audit/service'
import { RESOURCES } from '@/server/admin/resources'

export interface ProposalScope {
  projectId: string
  environmentId: string
}

// Supported proposal types: resource create payloads that map to RESOURCES
export const PROPOSAL_RESOURCE_MAP: Record<string, string> = {
  'rule.create': 'rules',
  'achievement.create': 'achievements',
  'challenge.create': 'challenges',
  'streak.create': 'streaks',
  'leaderboard.create': 'leaderboards',
  'reward.create': 'rewards',
}

export interface CreateProposalInput {
  type: string
  payload: Record<string, unknown>
  rationale?: string
  proposedByKeyId?: string
  proposedByName?: string
}

// ---------------------------------------------------------------------------
// Create — validate the payload dry, store pending
// ---------------------------------------------------------------------------

export async function createProposal(input: CreateProposalInput, scope: ProposalScope) {
  const resource = PROPOSAL_RESOURCE_MAP[input.type]
  if (!resource) {
    throw new PlatformError({
      code: 'PROPOSAL_TYPE_UNSUPPORTED',
      category: 'validation',
      message: `Proposal type "${input.type}" is not supported.`,
      fix: `Supported: ${Object.keys(PROPOSAL_RESOURCE_MAP).join(', ')}`,
    })
  }
  const config = RESOURCES[resource]

  // validate the proposed object exactly like manual creation — invalid
  // proposals are rejected at submission time, not at approval time.
  // JSON-typed fields accept both string and parsed-object forms (MCP
  // clients naturally send objects); normalize to the storage convention.
  const data: Record<string, unknown> = {}
  for (const field of config.fields) {
    if (input.payload[field] === undefined) continue
    const value = input.payload[field]
    if (field.endsWith('Json')) {
      data[field] = typeof value === 'string' ? value : JSON.stringify(value)
    } else {
      data[field] = value
    }
  }
  for (const required of config.requiredOnCreate ?? []) {
    if (data[required] === undefined || data[required] === null || data[required] === '') {
      throw new PlatformError({
        code: 'FIELD_REQUIRED',
        category: 'validation',
        message: `Proposed object is missing required field "${required}".`,
      })
    }
  }
  await config.validate?.(data, 'create')

  const proposal = await db.proposal.create({
    data: {
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      type: input.type,
      payloadJson: JSON.stringify(data),
      rationale: input.rationale ?? null,
      status: 'pending',
      proposedByKeyId: input.proposedByKeyId ?? null,
      proposedByName: input.proposedByName ?? null,
    },
  })

  return {
    id: proposal.id,
    type: proposal.type,
    status: proposal.status,
    createdAt: proposal.createdAt,
    rationale: proposal.rationale,
    note: 'Proposal stored as pending — a human must approve it before anything is written. Track it via GET /api/v1/proposals.',
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listProposals(scope: ProposalScope, status?: string) {
  const where: Record<string, unknown> = { projectId: scope.projectId, environmentId: scope.environmentId }
  if (status) where.status = status
  const proposals = await db.proposal.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return proposals.map(serializeProposal)
}

export function serializeProposal(p: {
  id: string
  type: string
  payloadJson: string
  rationale: string | null
  status: string
  proposedByName: string | null
  decidedAt: Date | null
  decisionNote: string | null
  resultJson: string | null
  createdAt: Date
}) {
  let payload: unknown = null
  let result: unknown = null
  try {
    payload = JSON.parse(p.payloadJson)
  } catch {
    payload = p.payloadJson
  }
  try {
    result = p.resultJson ? JSON.parse(p.resultJson) : null
  } catch {
    result = p.resultJson
  }
  return {
    id: p.id,
    type: p.type,
    payload,
    rationale: p.rationale,
    status: p.status,
    proposedBy: p.proposedByName,
    decidedAt: p.decidedAt,
    decisionNote: p.decisionNote,
    result,
    createdAt: p.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Decide — human-only approval / rejection
// ---------------------------------------------------------------------------

export async function decideProposal(
  proposalId: string,
  decision: 'approve' | 'reject',
  scope: ProposalScope,
  adminUserId: string,
  note?: string,
) {
  const proposal = await db.proposal.findFirst({
    where: { id: proposalId, projectId: scope.projectId, environmentId: scope.environmentId },
  })
  if (!proposal) {
    throw new PlatformError({
      code: 'PROPOSAL_NOT_FOUND',
      category: 'not_found',
      message: `Proposal ${proposalId} not found in this environment.`,
    })
  }
  if (proposal.status !== 'pending') {
    throw new PlatformError({
      code: 'PROPOSAL_ALREADY_DECIDED',
      category: 'conflict',
      message: `Proposal is already ${proposal.status}.`,
      fix: 'Only pending proposals can be decided.',
    })
  }

  if (decision === 'reject') {
    const updated = await db.proposal.update({
      where: { id: proposal.id },
      data: {
        status: 'rejected',
        decidedBy: adminUserId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
    })
    await recordAudit({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      actorType: 'human',
      actorId: adminUserId,
      action: 'proposal.rejected',
      targetType: 'proposal',
      targetId: proposal.id,
      beforeJson: JSON.stringify(serializeProposal(proposal)),
      reason: note ?? null,
    })
    return { status: 'rejected', proposal: serializeProposal(updated) }
  }

  // approve → execute through the same validated create path
  const resource = PROPOSAL_RESOURCE_MAP[proposal.type]
  const config = RESOURCES[resource]
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(proposal.payloadJson) as Record<string, unknown>
  } catch {
    payload = {}
  }

  // re-validate at decision time (configuration may have drifted since submission)
  const data: Record<string, unknown> = {}
  for (const field of config.fields) {
    if (payload[field] !== undefined) data[field] = payload[field]
  }
  await config.validate?.(data, 'create')

  try {
    // @ts-expect-error dynamic prisma delegate access
    const delegate = db[config.delegate] as { create: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
    const created = await delegate.create({
      data: {
        ...data,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        // provenance: approved AI proposal (§68 AI memory / §70 decision trace)
        ...(config.fields.includes('metadataJson')
          ? { metadataJson: JSON.stringify({ proposedByAi: true, proposalId: proposal.id, proposedBy: proposal.proposedByName ?? 'ai-agent' }) }
          : {}),
      },
    })

    const updated = await db.proposal.update({
      where: { id: proposal.id },
      data: {
        status: 'approved',
        decidedBy: adminUserId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
        resultJson: JSON.stringify({ createdId: created.id }),
      },
    })

    await recordAudit({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      actorType: 'ai',
      actorId: proposal.proposedByName ?? proposal.proposedByKeyId ?? 'ai-agent',
      action: `${config.auditType}.created`,
      targetType: config.auditType,
      targetId: String(created.id),
      afterJson: JSON.stringify(created),
      reason: `AI proposal ${proposal.id} approved by admin ${adminUserId}${note ? `: ${note}` : ''}`,
    })
    await recordAudit({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      actorType: 'human',
      actorId: adminUserId,
      action: 'proposal.approved',
      targetType: 'proposal',
      targetId: proposal.id,
      beforeJson: JSON.stringify(serializeProposal(proposal)),
      afterJson: JSON.stringify({ createdId: created.id }),
      reason: note ?? null,
    })

    return { status: 'approved', createdId: created.id, proposal: serializeProposal(updated) }
  } catch (e) {
    // execution failure → proposal marked failed, nothing persisted
    const message = e instanceof Error ? e.message : 'execution failed'
    await db.proposal.update({
      where: { id: proposal.id },
      data: {
        status: 'failed',
        decidedBy: adminUserId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
        resultJson: JSON.stringify({ error: message }),
      },
    })
    await recordAudit({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      actorType: 'human',
      actorId: adminUserId,
      action: 'proposal.failed',
      targetType: 'proposal',
      targetId: proposal.id,
      afterJson: JSON.stringify({ error: message }),
      reason: note ?? null,
    })
    throw new PlatformError({
      code: 'PROPOSAL_EXECUTION_FAILED',
      category: 'engine',
      message: `Proposal approved but execution failed: ${message}`,
      fix: 'The proposal is marked failed; nothing was persisted. Fix the underlying conflict and submit a new proposal.',
    })
  }
}
