'use client'

/**
 * Users explorer page — full per-user state (progression, wallets,
 * achievements, streaks) + user deep dive.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, Search, Users, Trophy, Flame, Coins, GitBranch, ChevronRight } from 'lucide-react'
import { apiGet, formatRelative } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface UserRow {
  id: string
  externalId: string
  displayName: string | null
  anonymous: boolean
  status: string
  lastSeenAt: string | null
  createdAt: string
  progression: Array<{ track: string; xp: number; level: number }>
  wallets: Array<{ currency: string; balance: number }>
  achievements: Array<{ code: string; name: string; unlockedAt: string | null }>
  streaks: Array<{ key: string; current: number; best: number }>
}

interface UserDetail {
  state: {
    user: { external_id: string; display_name: string | null; anonymous: boolean; attributes: Record<string, unknown> }
    progression: Array<{ track: string; trackName: string; xp: number; level: number; maxLevel: number; xpForNextLevel: number; progressPercent: number }>
    wallets: Array<{ currency: string; balance: number; currencyType: string }>
    inventory: Array<{ code: string; name: string; quantity: number; type: string }>
    achievements: Array<{ code: string; name: string; unlocked: boolean; icon: string | null; progressPercent: number }>
    challenges: Array<{ name: string; target: number; progress: number; completed: boolean; progressPercent: number }>
    streaks: Array<{ key: string; name: string; current: number; best: number }>
    variables: Record<string, unknown>
  }
  ledger: Array<{ id: string; currency: string; amount: number; type: string; source: string; balanceAfter: number; createdAt: string }>
}

export default function UsersPage() {
  const auth = useAuthGuard()
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ users: UserRow[] }>('/api/admin/users/list')
      setUsers(data.users)
    } catch {
      toast.error('Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status, load])

  const openDetail = async (externalId: string) => {
    setSelected(externalId)
    setDetailLoading(true)
    try {
      const data = await apiGet<UserDetail>(`/api/admin/users/list?externalId=${encodeURIComponent(externalId)}`)
      setDetail(data)
    } catch {
      toast.error('Failed to load user detail')
    } finally {
      setDetailLoading(false)
    }
  }

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="Users" subtitle="End-user explorer">
        <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      </DashboardShell>
    )
  }
  if (auth.status !== 'authenticated') return null

  const filtered = query
    ? users.filter((u) => u.externalId.toLowerCase().includes(query.toLowerCase()) || (u.displayName ?? '').toLowerCase().includes(query.toLowerCase()))
    : users

  return (
    <DashboardShell
      title="Users"
      subtitle="Every end user with their full engagement state"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search users..." className="pl-9" aria-label="Search users" />
          </div>
          <Button variant="outline" size="sm" onClick={load} aria-label="Refresh">
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
          <Badge variant="secondary" className="text-[11px] ml-auto">{filtered.length} users</Badge>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
          {/* User list */}
          <Card className="xl:col-span-2 h-fit overflow-hidden">
            <CardContent className="p-0">
              <div className="max-h-[620px] overflow-y-auto">
                {loading && users.length === 0 ? (
                  <div className="py-12 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                ) : filtered.length === 0 ? (
                  <div className="py-12 text-center">
                    <Users className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">No users found</p>
                  </div>
                ) : (
                  <div className="divide-y">
                    {filtered.map((u) => {
                      const defaultTrack = u.progression.find((p) => p.track === 'default')
                      return (
                        <button
                          key={u.id}
                          onClick={() => openDetail(u.externalId)}
                          className={cn(
                            'w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors',
                            selected === u.externalId && 'bg-primary/5',
                          )}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium truncate flex-1">{u.displayName ?? u.externalId}</span>
                            {u.anonymous && <Badge variant="outline" className="text-[10px]">anon</Badge>}
                            <Badge variant="secondary" className="text-[10px]">L{defaultTrack?.level ?? 1}</Badge>
                            <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
                            <span className="tabular-nums">{defaultTrack?.xp ?? 0} XP</span>
                            {u.wallets.map((w) => (
                              <span key={w.currency} className="tabular-nums">{w.currency}: {w.balance.toLocaleString()}</span>
                            ))}
                            <span>🏆 {u.achievements.length}</span>
                            <span className="ml-auto">{formatRelative(u.lastSeenAt)}</span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* User detail */}
          <div className="xl:col-span-3 space-y-4">
            {detailLoading ? (
              <Card><CardContent className="py-16 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></CardContent></Card>
            ) : !detail ? (
              <Card><CardContent className="py-16 text-center text-sm text-muted-foreground">Select a user to view their full state</CardContent></Card>
            ) : (
              <>
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">
                      {detail.state.user.display_name ?? detail.state.user.external_id}
                      {detail.state.user.anonymous && <Badge variant="outline" className="ml-2 text-[10px]">anonymous</Badge>}
                    </CardTitle>
                    <CardDescription>
                      external_id {detail.state.user.external_id} · attributes {Object.keys(detail.state.user.attributes).length}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <div className="space-y-2.5">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><GitBranch className="h-3.5 w-3.5" /> Progression</p>
                      {detail.state.progression.map((p) => (
                        <div key={p.track} className="space-y-1">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium">Level {p.level}<span className="text-muted-foreground font-normal text-xs"> / {p.maxLevel}</span></span>
                            <span className="text-xs text-muted-foreground tabular-nums">{p.xp.toLocaleString()} XP</span>
                          </div>
                          <Progress value={p.progressPercent} className="h-2" />
                        </div>
                      ))}
                      {detail.state.progression.length === 0 && <p className="text-xs text-muted-foreground">No XP yet</p>}
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><Coins className="h-3.5 w-3.5" /> Wallets</p>
                      {detail.state.wallets.map((w) => (
                        <div key={w.currency} className="flex items-center justify-between text-sm rounded-lg border px-3 py-1.5">
                          <span className="font-medium">{w.currency} <span className="text-[10px] text-muted-foreground">{w.currencyType}</span></span>
                          <span className="tabular-nums font-semibold">{w.balance.toLocaleString()}</span>
                        </div>
                      ))}
                      {detail.state.wallets.length === 0 && <p className="text-xs text-muted-foreground">Empty</p>}
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><Trophy className="h-3.5 w-3.5" /> Achievements</p>
                      <div className="flex flex-wrap gap-1.5">
                        {detail.state.achievements.map((a) => (
                          <Badge key={a.code} variant={a.unlocked ? 'default' : 'outline'} className={cn('text-[11px]', !a.unlocked && 'opacity-50')}>
                            {a.icon ?? '🏅'} {a.name}
                          </Badge>
                        ))}
                        {detail.state.achievements.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><Flame className="h-3.5 w-3.5" /> Streaks</p>
                      {detail.state.streaks.map((s) => (
                        <div key={s.key} className="flex items-center justify-between text-sm rounded-lg border px-3 py-1.5">
                          <span className="text-xs truncate">{s.name}</span>
                          <span className="text-xs font-semibold tabular-nums">🔥 {s.current}</span>
                        </div>
                      ))}
                      {detail.state.streaks.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
                    </div>
                    {/* challenges */}
                    <div className="space-y-2 sm:col-span-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Challenges</p>
                      {detail.state.challenges.map((c) => (
                        <div key={c.name} className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="truncate">{c.completed ? '✅ ' : ''}{c.name}</span>
                            <span className="text-muted-foreground tabular-nums">{c.progress}/{c.target}</span>
                          </div>
                          <Progress value={c.progressPercent} className="h-1.5" />
                        </div>
                      ))}
                      {detail.state.challenges.length === 0 && <p className="text-xs text-muted-foreground">None active</p>}
                    </div>
                  </CardContent>
                </Card>

                {/* Ledger */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Ledger history</CardTitle>
                  </CardHeader>
                  <CardContent className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Currency</TableHead>
                          <TableHead>Amount</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Source</TableHead>
                          <TableHead>After</TableHead>
                          <TableHead>When</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.ledger.length === 0 ? (
                          <TableRow><TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">No transactions</TableCell></TableRow>
                        ) : (
                          detail.ledger.map((t) => (
                            <TableRow key={t.id}>
                              <TableCell><code className="text-xs font-mono">{t.currency}</code></TableCell>
                              <TableCell>
                                <span className={cn('text-sm font-semibold tabular-nums', t.amount > 0 ? 'text-emerald-600' : 'text-red-600')}>
                                  {t.amount > 0 ? '+' : ''}{t.amount.toLocaleString()}
                                </span>
                              </TableCell>
                              <TableCell><Badge variant="outline" className="text-[10px]">{t.type}</Badge></TableCell>
                              <TableCell className="text-xs text-muted-foreground">{t.source}</TableCell>
                              <TableCell className="text-sm tabular-nums">{t.balanceAfter.toLocaleString()}</TableCell>
                              <TableCell className="text-[11px] text-muted-foreground whitespace-nowrap">{formatRelative(t.createdAt)}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </div>
      </div>
    </DashboardShell>
  )
}
