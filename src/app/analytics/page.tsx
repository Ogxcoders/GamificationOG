'use client'

/**
 * Analytics page (Section 76) — aggregates, charts, event type breakdown.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, RotateCcw, TrendingUp, Users, Zap, Award } from 'lucide-react'
import { apiGet, apiPost, isApiError, formatRelative } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface AnalyticsData {
  summary: {
    totals: Record<string, number>
    daily: Array<{ date: string; metricType: string; value: number }>
    topEventTypes: Array<{ type: string; count: number }>
    lastNDays: number
  }
  scope: { projectName: string; environmentName: string }
}

const METRIC_LABELS: Record<string, string> = {
  events_ingested: 'Events ingested',
  events_processed: 'Events processed',
  active_users: 'Active users',
  new_users: 'New users',
  actions_executed: 'Actions executed',
}

export default function AnalyticsPage() {
  const auth = useAuthGuard()
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState(14)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiGet<AnalyticsData>(`/api/admin/analytics/summary?days=${days}`)
      setData(res)
    } catch {
      toast.error('Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status, load])

  const rebuild = async () => {
    const res = await apiPost('/api/admin/analytics/summary', { action: 'rebuild' })
    if (isApiError(res)) {
      toast.error(res.error.message)
      return
    }
    toast.success('Analytics rebuilt from raw events')
    load()
  }

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="Analytics" subtitle="Aggregated engagement metrics">
        <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      </DashboardShell>
    )
  }
  if (auth.status !== 'authenticated') return null

  const totals = data?.summary.totals ?? {}
  const daily = data?.summary.daily ?? []
  const series = (metric: string) => daily.filter((d) => d.metricType === metric)
  const maxOf = (arr: Array<{ value: number }>) => Math.max(1, ...arr.map((d) => d.value))

  return (
    <DashboardShell
      title="Analytics"
      subtitle="Daily aggregate read models — rebuildable from raw events"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {[7, 14, 30, 90].map((d) => (
            <Button key={d} variant={days === d ? 'default' : 'outline'} size="sm" onClick={() => setDays(d)}>
              {d}d
            </Button>
          ))}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={rebuild}>
              <RotateCcw className="h-4 w-4 mr-1.5" /> Rebuild from events
            </Button>
            <Button variant="outline" size="sm" onClick={load} aria-label="Refresh">
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
          </div>
        </div>

        {/* Totals */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          {Object.entries(METRIC_LABELS).map(([metric, label]) => (
            <Card key={metric}>
              <CardContent className="p-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground truncate">{label}</p>
                <p className="text-2xl font-bold tabular-nums mt-1.5">{(totals[metric] ?? 0).toLocaleString()}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">last {days} days</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {['events_ingested', 'active_users'].map((metric) => {
            const s = series(metric)
            const max = maxOf(s)
            const color = metric === 'events_ingested' ? 'bg-primary' : 'bg-emerald-500'
            return (
              <Card key={metric}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    {metric === 'events_ingested' ? <Zap className="h-4 w-4 text-amber-600" /> : <Users className="h-4 w-4 text-emerald-600" />}
                    {METRIC_LABELS[metric]}
                  </CardTitle>
                  <CardDescription>Daily breakdown</CardDescription>
                </CardHeader>
                <CardContent>
                  {s.length === 0 ? (
                    <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">No data</div>
                  ) : (
                    <div className="flex items-end gap-1 h-32" role="img" aria-label={`${METRIC_LABELS[metric]} chart`}>
                      {s.slice(-days).map((d) => (
                        <div key={d.date} className="flex-1 group relative min-w-[4px]">
                          <div className={cn('w-full rounded-t opacity-80 group-hover:opacity-100 transition-opacity', color)} style={{ height: `${Math.max(3, (d.value / max) * 120)}px` }} />
                          <span className="absolute -top-7 left-1/2 -translate-x-1/2 hidden group-hover:block text-[10px] bg-foreground text-background px-1.5 py-0.5 rounded whitespace-nowrap z-10">
                            {d.date.slice(5)}: {d.value.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>

        {/* Top event types */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" /> Event type distribution</CardTitle>
            <CardDescription>Volume by event type over the window</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(data?.summary.topEventTypes ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No events in window</p>
            ) : (
              (data?.summary.topEventTypes ?? []).map((t) => {
                const max = data?.summary.topEventTypes[0]?.count ?? 1
                return (
                  <div key={t.type} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <code className="font-mono text-xs">{t.type}</code>
                      <span className="text-xs text-muted-foreground tabular-nums">{t.count.toLocaleString()}</span>
                    </div>
                    <Progress value={(t.count / max) * 100} className="h-1.5" />
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  )
}
