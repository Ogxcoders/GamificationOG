'use client'

/**
 * Decision Traces page (Section 70) — full engine transparency.
 * Every pipeline step: context build, rule evaluations, action executions.
 */
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Loader2, RefreshCw, Activity, ChevronRight, ChevronDown, Timer, Layers, Zap } from 'lucide-react'
import { apiGet, formatRelative } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface TraceListItem {
  id: string
  eventType: string
  user: string | null
  summary: string | null
  actionsCount: number
  durationMs: number
  createdAt: string
  correlationId: string | null
}

interface TraceStep {
  step: number
  name: string
  detail: string
  matched?: boolean
  durationMs: number
}

interface TraceDetail {
  id: string
  eventType: string
  source: string
  summary: string | null
  actionsCount: number
  durationMs: number
  createdAt: string
  correlationId: string | null
  steps: TraceStep[]
  event: {
    eventId: string
    type: string
    payload: Record<string, unknown>
    user: string | null
    occurredAt: string
  } | null
}

const STEP_ICONS: Record<string, string> = {
  build_context: '🧠',
  evaluate_rules: '⚖️',
  process_challenges: '🎯',
  process_streaks: '🔥',
  process_leaderboards: '📊',
  evaluate_achievements: '🏆',
  sync_xp_leaderboards: '🔄',
}

export default function TracesPage() {
  const auth = useAuthGuard()
  const searchParams = useSearchParams()
  const [traces, setTraces] = useState<TraceListItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('id'))
  const [detail, setDetail] = useState<TraceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ traces: TraceListItem[] }>('/api/admin/traces/list?limit=60')
      setTraces(data.traces)
      if (!selectedId && data.traces.length > 0) {
        setSelectedId(data.traces[0].id)
      }
    } catch {
      toast.error('Failed to load traces')
    } finally {
      setLoading(false)
    }
  }, [selectedId])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status])  

  useEffect(() => {
    const id = searchParams.get('id')
    if (id) setSelectedId(id)
  }, [searchParams])

  useEffect(() => {
    if (!selectedId) return
    setDetailLoading(true)
    apiGet<{ trace: TraceDetail }>(`/api/admin/traces/list?id=${selectedId}`)
      .then((data) => {
        setDetail(data.trace)
        setExpandedSteps(new Set())
      })
      .catch(() => toast.error('Failed to load trace detail'))
      .finally(() => setDetailLoading(false))
  }, [selectedId])

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="Decision Traces" subtitle="Engine transparency">
        <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      </DashboardShell>
    )
  }
  if (auth.status !== 'authenticated') return null

  return (
    <DashboardShell
      title="Decision Traces"
      subtitle="Every engine decision, step by step — contexts, rules, actions, state changes"
    >
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Trace list */}
        <Card className="xl:col-span-1 h-fit">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Traces</CardTitle>
              <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh traces">
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </Button>
            </div>
            <CardDescription>Latest {traces.length} pipeline runs</CardDescription>
          </CardHeader>
          <CardContent className="max-h-[600px] overflow-y-auto space-y-1.5">
            {loading && traces.length === 0 ? (
              <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : traces.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No traces yet — track an event in the <a href="/playground" className="text-primary underline">Playground</a>
              </p>
            ) : (
              traces.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  className={cn(
                    'w-full text-left rounded-lg border px-3 py-2.5 transition-colors',
                    selectedId === t.id ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono truncate flex-1">{t.eventType}</code>
                    <Badge variant="secondary" className="text-[10px] shrink-0">{t.actionsCount} actions</Badge>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[11px] text-muted-foreground truncate flex-1">{t.user ?? '—'}</span>
                    <span className="text-[11px] text-muted-foreground/70 tabular-nums shrink-0">{t.durationMs}ms</span>
                    <span className="text-[11px] text-muted-foreground/60 shrink-0">{formatRelative(t.createdAt)}</span>
                  </div>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        {/* Trace detail */}
        <div className="xl:col-span-2 space-y-4">
          {detailLoading && !detail ? (
            <Card><CardContent className="py-16 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></CardContent></Card>
          ) : !detail ? (
            <Card><CardContent className="py-16 text-center text-sm text-muted-foreground">Select a trace to inspect</CardContent></Card>
          ) : (
            <>
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-mono flex items-center gap-2">
                    <Activity className="h-4 w-4 text-primary" /> {detail.eventType}
                  </CardTitle>
                  <CardDescription>
                    user {detail.event?.user ?? '—'} · source {detail.source} · correlation {detail.correlationId?.slice(0, 8) ?? '—'} · total {detail.durationMs}ms
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">Input event payload</p>
                  <pre className="text-xs font-mono bg-muted rounded-lg p-3 overflow-x-auto max-h-40 overflow-y-auto">
                    {JSON.stringify(detail.event?.payload ?? {}, null, 2)}
                  </pre>
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    <Badge variant="secondary" className="gap-1"><Layers className="h-3 w-3" /> {detail.steps.length} pipeline steps</Badge>
                    <Badge variant="secondary" className="gap-1"><Zap className="h-3 w-3" /> {detail.actionsCount} actions executed</Badge>
                    <Badge variant="secondary" className="gap-1"><Timer className="h-3 w-3" /> {detail.durationMs}ms total</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">{detail.summary}</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Pipeline steps</CardTitle>
                  <CardDescription>Expand each step for engine-level detail</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {detail.steps.map((step) => {
                    const expanded = expandedSteps.has(step.step)
                    return (
                      <div key={step.step} className="rounded-lg border overflow-hidden">
                        <button
                          onClick={() => setExpandedSteps((prev) => {
                            const next = new Set(prev)
                            if (next.has(step.step)) next.delete(step.step)
                            else next.add(step.step)
                            return next
                          })}
                          className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/50 transition-colors text-left"
                          aria-expanded={expanded}
                        >
                          {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                          <span className="text-base shrink-0">{STEP_ICONS[step.name] ?? '⚙️'}</span>
                          <code className="text-xs font-mono flex-1 truncate">{step.name}</code>
                          <span className="text-[11px] text-muted-foreground/70 tabular-nums shrink-0">{step.durationMs}ms</span>
                        </button>
                        {expanded && (
                          <div className="px-3 pb-3 pt-1 border-t bg-muted/30">
                            <p className="text-xs text-foreground/80 font-mono break-words whitespace-pre-wrap">{step.detail || '—'}</p>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </DashboardShell>
  )
}
