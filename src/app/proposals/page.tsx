'use client'

/**
 * Proposals page — AI change approval queue (Sections 66-67).
 * Agents propose; humans decide. Approve executes through the same
 * validated create path (audited with an 'ai' actor); reject closes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, CheckCircle2, XCircle, Bot, Clock, ShieldCheck, ChevronDown, ChevronRight } from 'lucide-react'
import { apiGet, apiPost, isApiError, formatRelative } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface Proposal {
  id: string
  type: string
  payload: Record<string, unknown>
  rationale: string | null
  status: string
  proposedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
  result: { createdId?: string; error?: string } | null
  createdAt: string
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  approved: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  rejected: 'bg-red-500/10 text-red-600 border-red-500/30',
  failed: 'bg-red-500/10 text-red-600 border-red-500/30',
}

function payloadSummary(payload: Record<string, unknown>): string {
  const parts: string[] = []
  if (payload.name) parts.push(String(payload.name))
  if (payload.eventType) parts.push(`WHEN ${String(payload.eventType)}`)
  if (payload.code) parts.push(String(payload.code))
  if (payload.key) parts.push(String(payload.key))
  if (payload.type) parts.push(String(payload.type))
  return parts.join(' · ')
}

export default function ProposalsPage() {
  const auth = useAuthGuard()
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [decideTarget, setDecideTarget] = useState<Proposal | null>(null)
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ proposals: Proposal[] }>(`/api/admin/proposals${filter === 'pending' ? '?status=pending' : ''}`)
      setProposals(data.proposals ?? [])
    } catch (e) {
      const payload = (e as { payload?: unknown }).payload
      if (isApiError(payload)) {
        toast.error(payload.error.message, { description: payload.error.fix })
      } else {
        toast.error(e instanceof Error ? e.message : 'Failed to load proposals')
      }
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status, load])

  const submitDecision = async () => {
    if (!decideTarget) return
    setBusy(true)
    try {
      const res = await apiPost<{ result: { status: string; createdId?: string } }>(
        `/api/admin/proposals/${decideTarget.id}/decide`,
        { decision, note: note.trim() || undefined },
      )
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
        return
      }
      toast.success(
        decision === 'approve' ? 'Proposal approved & executed' : 'Proposal rejected',
        {
          description: decision === 'approve'
            ? `Object created (${res.result.createdId?.slice(0, 12) ?? ''}…) — audited with an AI actor.`
            : 'No configuration was changed.',
        },
      )
      setDecideTarget(null)
      setNote('')
      load()
    } finally {
      setBusy(false)
    }
  }

  const pendingCount = useMemo(() => proposals.filter((p) => p.status === 'pending').length, [proposals])

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="AI Proposals" subtitle="Write-tools behind human approval">
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </DashboardShell>
    )
  }
  if (auth.status !== 'authenticated') return null

  return (
    <DashboardShell title="AI Proposals" subtitle="Write-tools behind human approval (§66-67)">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground max-w-3xl">
          AI agents (via the MCP control plane) can propose configuration changes — they can never write directly.
          Proposals are validated at submission; approving executes through the same validated create path used by
          manual configuration, with full audit lineage. <ShieldCheck className="h-3.5 w-3.5 inline -mt-0.5" /> Only
          human admins can decide.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5 gap-0.5 bg-background">
            {(['pending', 'all'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded px-3 py-1 text-xs font-medium transition-colors',
                  filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f === 'pending' ? `Pending${pendingCount > 0 ? ` (${pendingCount})` : ''}` : 'All history'}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={load} aria-label="Refresh">
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>

        {loading && proposals.length === 0 ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : proposals.length === 0 ? (
          <div className="rounded-xl border bg-card py-16 text-center">
            <Bot className="h-8 w-8 mx-auto mb-3 text-muted-foreground opacity-50" />
            <p className="text-sm text-muted-foreground">
              {filter === 'pending' ? 'No pending proposals — the AI has nothing waiting for review.' : 'No proposals yet.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {proposals.map((p) => (
              <div key={p.id} className="rounded-xl border bg-card overflow-hidden">
                <button
                  type="button"
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
                  onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                  aria-expanded={expanded === p.id}
                >
                  {expanded === p.id ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                  <div className={cn('h-8 w-8 rounded-lg flex items-center justify-center shrink-0', p.status === 'pending' ? 'bg-amber-500/10 text-amber-600' : 'bg-muted text-muted-foreground')}>
                    <Bot className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-xs font-mono font-medium">{p.type}</code>
                      <span className="text-xs text-muted-foreground truncate">{payloadSummary(p.payload)}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                      {p.proposedBy ? `${p.proposedBy} · ` : ''}{formatRelative(p.createdAt)}
                      {p.rationale ? ` · "${p.rationale.slice(0, 80)}${p.rationale.length > 80 ? '…' : ''}"` : ''}
                    </p>
                  </div>
                  <Badge variant="outline" className={cn('text-[10px] shrink-0', STATUS_STYLES[p.status] ?? '')}>
                    {p.status === 'pending' && <Clock className="h-3 w-3 mr-1" />}
                    {p.status}
                  </Badge>
                  {p.status === 'pending' && (
                    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/10"
                        onClick={() => { setDecideTarget(p); setDecision('approve') }}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs text-destructive border-red-500/30 hover:bg-red-500/10"
                        onClick={() => { setDecideTarget(p); setDecision('reject') }}
                      >
                        <XCircle className="h-3.5 w-3.5 mr-1" /> Reject
                      </Button>
                    </div>
                  )}
                </button>

                {expanded === p.id && (
                  <div className="border-t px-4 py-3 space-y-3 bg-muted/20">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Proposed configuration</p>
                      <pre className="text-xs font-mono bg-background border rounded-lg p-3 overflow-x-auto max-h-64">
                        {JSON.stringify(p.payload, null, 2)}
                      </pre>
                    </div>
                    {p.rationale && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">AI rationale</p>
                        <p className="text-xs">{p.rationale}</p>
                      </div>
                    )}
                    {p.decisionNote && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Decision note</p>
                        <p className="text-xs">{p.decisionNote}</p>
                      </div>
                    )}
                    {p.result && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Result</p>
                        <pre className="text-xs font-mono bg-background border rounded-lg p-3">{JSON.stringify(p.result, null, 2)}</pre>
                      </div>
                    )}
                    {p.status === 'pending' && (
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" onClick={() => { setDecideTarget(p); setDecision('approve') }}>
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" /> Approve & execute
                        </Button>
                        <Button size="sm" variant="outline" className="text-destructive" onClick={() => { setDecideTarget(p); setDecision('reject') }}>
                          <XCircle className="h-3.5 w-3.5 mr-1.5" /> Reject
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Decision dialog */}
      <Dialog open={decideTarget !== null} onOpenChange={(open) => !open && setDecideTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {decision === 'approve' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-destructive" />}
              {decision === 'approve' ? 'Approve & execute proposal' : 'Reject proposal'}
            </DialogTitle>
            <DialogDescription>
              {decision === 'approve'
                ? 'The proposed configuration will be created through the validated create path and audited (AI actor). This cannot be undone.'
                : 'The proposal will be closed without any configuration change.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <pre className="text-xs font-mono bg-muted rounded-lg p-3 overflow-x-auto max-h-52">
              {decideTarget ? JSON.stringify(decideTarget.payload, null, 2) : ''}
            </pre>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Decision note (optional — recorded in the audit trail)"
              rows={2}
              aria-label="Decision note"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecideTarget(null)}>Cancel</Button>
            <Button
              onClick={submitDecision}
              disabled={busy}
              variant={decision === 'approve' ? 'default' : 'destructive'}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {decision === 'approve' ? 'Approve & execute' : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardShell>
  )
}
