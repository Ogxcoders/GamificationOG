'use client'

/**
 * GamificationOG — Dashboard Overview (/ route).
 * The "Overview" information area (Section 107): live counters, analytics
 * chart, recent events, decision traces, top event types.
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Users, Zap, Activity, GitBranch, Target, Bell, ArrowUpRight, Loader2, RefreshCw, TrendingUp, Award, Coins } from 'lucide-react'
import { apiGet, formatRelative } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface OverviewData {
  counters: {
    totalUsers: number
    totalEvents: number
    activeToday: number
    rulesActive: number
    challengesActive: number
    unreadNotifications: number
  }
  summary: {
    totals: Record<string, number>
    daily: Array<{ date: string; metricType: string; value: number }>
    topEventTypes: Array<{ type: string; count: number }>
    lastNDays: number
  }
  recentTraces: Array<{ id: string; eventType: string; summary: string | null; actionsCount: number; durationMs: number; createdAt: string }>
  recentEvents: Array<{ eventId: string; eventType: string; status: string; source: string; receivedAt: string; user: string | null }>
  topAchievements: number
  scope: {
    projectName: string
    environmentName: string
  }
}

const EVENT_STATUS_COLORS: Record<string, string> = {
  processed: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  received: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  processing: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  failed: 'bg-red-500/10 text-red-600 border-red-500/30',
  duplicate: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/30',
  skipped: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/30',
}

function CounterCard({ label, value, icon: Icon, accent, href }: {
  label: string
  value: number | string
  icon: React.ComponentType<{ className?: string }>
  accent: string
  href?: string
}) {
  const content = (
    <Card className="hover:border-primary/40 transition-colors h-full">
      <CardContent className="p-4 lg:p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground truncate">{label}</p>
            <p className="text-2xl lg:text-3xl font-bold tracking-tight mt-1.5 tabular-nums">{value}</p>
          </div>
          <div className={cn('h-9 w-9 rounded-lg flex items-center justify-center shrink-0', accent)}>
            <Icon className="h-4.5 w-4.5" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
  return href ? <Link href={href}>{content}</Link> : content
}

export default function OverviewPage() {
  const auth = useAuthGuard()
  const router = useRouter()
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    apiGet<OverviewData>('/api/admin/analytics/summary')
      .then(setData)
      .catch((e) => {
        const payload = (e as { payload?: unknown }).payload
        if (payload && typeof payload === 'object' && 'error' in payload) {
          const err = (payload as { error: { message: string; fix?: string } }).error
          toast.error(err.message, { description: err.fix })
        } else {
          toast.error('Failed to load dashboard data')
        }
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (auth.status !== 'authenticated') return
    const t = setTimeout(load, 0)
    return () => clearTimeout(t)
  }, [auth.status])  

  if (auth.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (auth.status !== 'authenticated') return null

  // build 14-day chart series
  const eventsSeries = (data?.summary.daily ?? []).filter((d) => d.metricType === 'events_ingested')
  const maxEvents = Math.max(1, ...eventsSeries.map((d) => d.value))
  const activeSeries = (data?.summary.daily ?? []).filter((d) => d.metricType === 'active_users')
  const maxActive = Math.max(1, ...activeSeries.map((d) => d.value))

  const counters = data?.counters

  return (
    <DashboardShell
      title="Overview"
      subtitle={data?.scope ? `${data.scope.projectName} · ${data.scope.environmentName}` : 'Engagement at a glance'}
    >
      <div className="space-y-6">
        {/* KPI grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <CounterCard label="Total users" value={counters?.totalUsers ?? '—'} icon={Users} accent="bg-primary/10 text-primary" href="/users" />
          <CounterCard label="Active (24h)" value={counters?.activeToday ?? '—'} icon={Activity} accent="bg-emerald-500/10 text-emerald-600" href="/users" />
          <CounterCard label="Events ingested" value={counters?.totalEvents ?? '—'} icon={Zap} accent="bg-amber-500/10 text-amber-600" href="/events" />
          <CounterCard label="Active rules" value={counters?.rulesActive ?? '—'} icon={GitBranch} accent="bg-violet-500/10 text-violet-600" href="/rules" />
          <CounterCard label="Active challenges" value={counters?.challengesActive ?? '—'} icon={Target} accent="bg-pink-500/10 text-pink-600" href="/challenges" />
          <CounterCard label="Unread notifications" value={counters?.unreadNotifications ?? '—'} icon={Bell} accent="bg-sky-500/10 text-sky-600" />
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4 text-primary" /> Events ingested
              </CardTitle>
              <CardDescription>Last {data?.summary.lastNDays ?? 14} days</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="h-32 flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : eventsSeries.length === 0 ? (
                <div className="h-32 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Zap className="h-6 w-6 opacity-30" />
                  <p>No events yet — send one from the <Link href="/playground" className="text-primary underline underline-offset-2">Playground</Link></p>
                </div>
              ) : (
                <div className="flex items-end gap-1.5 h-32" role="img" aria-label="Events ingested per day bar chart">
                  {eventsSeries.slice(-30).map((d) => (
                    <div key={d.date} className="flex-1 group relative min-w-[4px]">
                      <div
                        className="w-full rounded-t bg-primary/70 group-hover:bg-primary transition-colors"
                        style={{ height: `${Math.max(3, (d.value / maxEvents) * 120)}px` }}
                      />
                      <span className="absolute -top-7 left-1/2 -translate-x-1/2 hidden group-hover:block text-[10px] bg-foreground text-background px-1.5 py-0.5 rounded whitespace-nowrap z-10">
                        {d.date.slice(5)}: {d.value}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4 text-emerald-600" /> Active users
              </CardTitle>
              <CardDescription>Daily unique event actors</CardDescription>
            </CardHeader>
            <CardContent>
              {activeSeries.length === 0 ? (
                <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">No active-user data yet</div>
              ) : (
                <div className="flex items-end gap-1.5 h-32" role="img" aria-label="Active users per day bar chart">
                  {activeSeries.slice(-30).map((d) => (
                    <div key={d.date} className="flex-1 group relative min-w-[4px]">
                      <div
                        className="w-full rounded-t bg-emerald-500/70 group-hover:bg-emerald-500 transition-colors"
                        style={{ height: `${Math.max(3, (d.value / maxActive) * 120)}px` }}
                      />
                      <span className="absolute -top-7 left-1/2 -translate-x-1/2 hidden group-hover:block text-[10px] bg-foreground text-background px-1.5 py-0.5 rounded whitespace-nowrap z-10">
                        {d.date.slice(5)}: {d.value}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Bottom row: recent events + traces */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Zap className="h-4 w-4 text-amber-600" /> Recent events
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={() => router.push('/events')}>
                  View all <ArrowUpRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-1.5 max-h-[340px] overflow-y-auto">
              {loading ? (
                <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : (data?.recentEvents ?? []).length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No events yet. Track one via the SDK, API, or <Link href="/playground" className="text-primary underline">Playground</Link>.
                </p>
              ) : (
                (data?.recentEvents ?? []).map((e) => (
                  <div key={e.eventId} className="flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm hover:bg-muted/50 transition-colors">
                    <Badge variant="outline" className={cn('text-[10px] shrink-0', EVENT_STATUS_COLORS[e.status] ?? '')}>
                      {e.status}
                    </Badge>
                    <code className="text-xs font-mono truncate flex-1">{e.eventType}</code>
                    <span className="text-xs text-muted-foreground truncate hidden sm:block max-w-[110px]">{e.user ?? '—'}</span>
                    <span className="text-[11px] text-muted-foreground/70 shrink-0">{formatRelative(e.receivedAt)}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="h-4 w-4 text-primary" /> Recent decision traces
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={() => router.push('/traces')}>
                  View all <ArrowUpRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-1.5 max-h-[340px] overflow-y-auto">
              {loading ? (
                <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : (data?.recentTraces ?? []).length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No traces yet — traces record every engine decision end to end.
                </p>
              ) : (
                (data?.recentTraces ?? []).map((t) => (
                  <Link
                    key={t.id}
                    href={`/traces?id=${t.id}`}
                    className="flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                  >
                    <code className="text-xs font-mono truncate flex-1">{t.eventType}</code>
                    <Badge variant="secondary" className="text-[10px] shrink-0">{t.actionsCount} actions</Badge>
                    <span className="text-[11px] text-muted-foreground/70 shrink-0 tabular-nums">{t.durationMs}ms</span>
                    <span className="text-[11px] text-muted-foreground/70 shrink-0 hidden sm:block">{formatRelative(t.createdAt)}</span>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* Top event types */}
        {(data?.summary.topEventTypes ?? []).length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Top event types</CardTitle>
              <CardDescription>Volume by type — the shape of your engagement loop</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {(data?.summary.topEventTypes ?? []).slice(0, 9).map((t) => {
                const max = data?.summary.topEventTypes[0]?.count ?? 1
                return (
                  <div key={t.type} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <code className="font-mono text-xs truncate">{t.type}</code>
                      <span className="text-xs text-muted-foreground tabular-nums">{t.count}</span>
                    </div>
                    <Progress value={(t.count / max) * 100} className="h-1.5" />
                  </div>
                )
              })}
            </CardContent>
          </Card>
        )}

        {/* Quick actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4 mr-1.5" /> Refresh
          </Button>
          <Button size="sm" onClick={() => router.push('/playground')}>
            <Zap className="h-4 w-4 mr-1.5" /> Open Playground
          </Button>
          <Button variant="outline" size="sm" onClick={() => router.push('/rules')}>
            <GitBranch className="h-4 w-4 mr-1.5" /> Configure rules
          </Button>
          <Button variant="outline" size="sm" onClick={() => router.push('/economy')}>
            <Coins className="h-4 w-4 mr-1.5" /> Economy
          </Button>
          <Button variant="outline" size="sm" onClick={() => router.push('/registry')}>
            <Award className="h-4 w-4 mr-1.5" /> Capabilities
          </Button>
        </div>
      </div>
    </DashboardShell>
  )
}
