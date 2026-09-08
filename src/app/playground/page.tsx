'use client'

/**
 * Playground (Customer Zero simulator, Section 103):
 * identify user -> track event -> see state change -> see decision trace.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Send, UserPlus, RefreshCw, Zap, Trophy, Flame, Coins, Package, GitBranch, Target } from 'lucide-react'
import { apiGet, apiPost, isApiError, formatRelative } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface PlaygroundUser {
  id: string
  externalId: string
  displayName: string | null
  anonymous: boolean
  lastSeenAt: string | null
  level: number
  xp: number
  balances: Array<{ code: string; balance: number }>
  achievements: number
}

interface SchemaInfo {
  name: string
  version: number
  description: string | null
  payloadSchema: Record<string, unknown>
}

interface UserState {
  user: { external_id: string; display_name: string | null; anonymous: boolean }
  progression: Array<{ track: string; level: number; xp: number; maxLevel: number; xpForNextLevel: number; progressPercent: number }>
  wallets: Array<{ currency: string; balance: number; currencyType: string }>
  inventory: Array<{ code: string; name: string; quantity: number; type: string }>
  achievements: Array<{ code: string; name: string; unlocked: boolean; icon: string | null; progressPercent: number }>
  challenges: Array<{ name: string; target: number; progress: number; completed: boolean; progressPercent: number; type: string }>
  streaks: Array<{ key: string; name: string; current: number; best: number }>
}

interface TrackResult {
  result: {
    eventId: string
    status: string
    traceId?: string
    actions: Array<{ action: string; status: string; detail: string }>
    stateDelta: {
      xpAwarded: number
      levelUps: Array<{ track: string; from: number; to: number }>
      currencyChanges: Array<{ currency: string; amount: number; balanceAfter: number }>
      achievementsUnlocked: Array<{ code: string; name: string }>
      challengesCompleted: Array<{ name: string }>
      streak: { key: string; current: number; best: number } | null
      leaderboardUpdates: Array<{ leaderboard: string; score: number; rank: number | null }>
    }
  }
  state: UserState | null
}

export default function PlaygroundPage() {
  const auth = useAuthGuard()
  const [users, setUsers] = useState<PlaygroundUser[]>([])
  const [schemas, setSchemas] = useState<SchemaInfo[]>([])
  const [selectedUser, setSelectedUser] = useState('')
  const [newUser, setNewUser] = useState('')
  const [eventType, setEventType] = useState('')
  const [payloadText, setPayloadText] = useState('{}')
  const [lastResult, setLastResult] = useState<TrackResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ users: PlaygroundUser[]; eventSchemas: SchemaInfo[] }>('/api/admin/playground/track')
      setUsers(data.users)
      setSchemas(data.eventSchemas)
      if (!selectedUser && data.users.length > 0) setSelectedUser(data.users[0].externalId)
      if (!eventType && data.eventSchemas.length > 0) setEventType(data.eventSchemas[0].name)
    } catch {
      toast.error('Failed to load playground data')
    } finally {
      setLoading(false)
    }
  }, [selectedUser, eventType])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status])  

  const identify = async () => {
    if (!newUser.trim()) {
      toast.error('Enter an external user id first')
      return
    }
    const res = await apiPost('/api/admin/playground/track', {
      action: 'track',
      external_user_id: newUser.trim(),
      create_user: true,
      display_name: newUser.trim(),
      event_type: 'user.session.start',
      payload: {},
    })
    if (isApiError(res)) {
      toast.error(res.error.message, { description: res.error.fix })
      return
    }
    toast.success(`User "${newUser}" identified`, { description: 'A session.start event was tracked to bootstrap them.' })
    setLastResult(res as TrackResult)
    setSelectedUser(newUser.trim())
    setNewUser('')
    load()
  }

  const track = async () => {
    if (!eventType) {
      toast.error('Select an event type')
      return
    }
    if (!selectedUser) {
      toast.error('Select or create a user first')
      return
    }
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(payloadText || '{}')
    } catch {
      toast.error('Payload must be valid JSON')
      return
    }
    setBusy(true)
    try {
      const res = await apiPost<TrackResult>('/api/admin/playground/track', {
        action: 'track',
        external_user_id: selectedUser,
        event_type: eventType,
        payload,
      })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
        return
      }
      setLastResult(res)
      toast.success(`Event processed: ${res.result.status}`, {
        description: `${res.result.actions.filter((a) => a.status === 'executed').length} actions executed`,
      })
      load()
    } finally {
      setBusy(false)
    }
  }

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="Playground" subtitle="Customer Zero simulator">
        <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      </DashboardShell>
    )
  }
  if (auth.status !== 'authenticated') return null

  const state = lastResult?.state
  const delta = lastResult?.result.stateDelta

  return (
    <DashboardShell
      title="Playground"
      subtitle="Simulate the full loop: identify → track event → see state change → see decision trace"
    >
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Left: simulator controls */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2"><UserPlus className="h-4 w-4 text-primary" /> Identify a user</CardTitle>
              <CardDescription>Anonymous or named — identical to calling sdk.identify()</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input value={newUser} onChange={(e) => setNewUser(e.target.value)} placeholder="user_123" aria-label="New user id" />
                <Button size="sm" onClick={identify}>Create</Button>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Existing users ({users.length})</Label>
                <div className="mt-1.5 flex flex-wrap gap-1.5 max-h-[120px] overflow-y-auto">
                  {users.map((u) => (
                    <button
                      key={u.id}
                      onClick={() => setSelectedUser(u.externalId)}
                      className={cn(
                        'text-xs px-2 py-1 rounded-md border transition-colors',
                        selectedUser === u.externalId ? 'bg-primary/10 border-primary/40 text-primary font-medium' : 'hover:bg-muted',
                      )}
                    >
                      {u.externalId}
                      {u.level > 1 && <span className="ml-1 text-muted-foreground">L{u.level}</span>}
                    </button>
                  ))}
                  {users.length === 0 && !loading && <p className="text-xs text-muted-foreground">No users yet — create one above.</p>}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2"><Zap className="h-4 w-4 text-amber-600" /> Track an event</CardTitle>
              <CardDescription>Fires through the full engine pipeline</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Event type</Label>
                <div className="flex flex-wrap gap-1.5">
                  {schemas.map((s) => (
                    <button
                      key={s.name}
                      onClick={() => {
                        setEventType(s.name)
                        // prefill payload from schema
                        const spec = s.payloadSchema as Record<string, { type?: string }>
                        const sample: Record<string, unknown> = {}
                        for (const [k, v] of Object.entries(spec)) {
                          if (v?.type === 'number') sample[k] = 1
                          else if (v?.type === 'boolean') sample[k] = true
                          else if (Array.isArray((v as { enum?: unknown[] }).enum) && (v as { enum: unknown[] }).enum.length > 0) sample[k] = (v as { enum: unknown[] }).enum[0]
                          else sample[k] = 'value'
                        }
                        setPayloadText(JSON.stringify(sample, null, 2))
                      }}
                      className={cn(
                        'text-[11px] px-2 py-1 rounded-md border font-mono transition-colors',
                        eventType === s.name ? 'bg-amber-500/10 border-amber-500/40 text-amber-700 font-medium' : 'hover:bg-muted',
                      )}
                    >
                      {s.name}
                    </button>
                  ))}
                  {schemas.length === 0 && <p className="text-xs text-muted-foreground">No schemas — events still work (no validation).</p>}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="payload">Payload (JSON)</Label>
                <textarea
                  id="payload"
                  value={payloadText}
                  onChange={(e) => setPayloadText(e.target.value)}
                  rows={5}
                  className="w-full rounded-md border bg-transparent px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <Button className="w-full" onClick={track} disabled={busy || !selectedUser}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
                Track event as {selectedUser ? `"${selectedUser}"` : '—'}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Middle+right: results */}
        <div className="xl:col-span-2 space-y-4">
          {lastResult && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <CardTitle className="text-base">Engine result</CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={cn('text-[10px]', lastResult.result.status === 'processed' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : '')}>
                      {lastResult.result.status}
                    </Badge>
                    {lastResult.result.traceId && (
                      <a href={`/traces?id=${lastResult.result.traceId}`} className="text-xs text-primary underline underline-offset-2">
                        View decision trace →
                      </a>
                    )}
                  </div>
                </div>
                <CardDescription>{lastResult.result.actions.length} action results</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 max-h-[300px] overflow-y-auto">
                {lastResult.result.actions.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No actions executed — no rules matched. Configure rules or check the trace for why.
                  </p>
                ) : (
                  lastResult.result.actions.map((a, i) => (
                    <div key={i} className="flex items-start gap-2.5 rounded-lg border px-3 py-2">
                      <Badge variant="outline" className={cn('text-[10px] shrink-0 mt-0.5', a.status === 'executed' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : a.status === 'failed' ? 'bg-red-500/10 text-red-600 border-red-500/30' : 'bg-zinc-500/10 text-zinc-500 border-zinc-500/30')}>
                        {a.status}
                      </Badge>
                      <div className="min-w-0">
                        <code className="text-xs font-mono">{a.action}</code>
                        <p className="text-xs text-muted-foreground mt-0.5 break-words">{a.detail}</p>
                      </div>
                    </div>
                  ))
                )}
                {delta && (delta.xpAwarded > 0 || delta.levelUps.length > 0 || delta.currencyChanges.length > 0 || delta.achievementsUnlocked.length > 0 || delta.challengesCompleted.length > 0 || delta.streak) && (
                  <div className="rounded-lg bg-primary/5 border border-primary/20 px-3 py-2.5 space-y-1 text-sm">
                    <p className="text-xs font-semibold text-primary uppercase tracking-wide">State delta</p>
                    {delta.xpAwarded > 0 && <p className="text-xs">⚡ +{delta.xpAwarded} XP</p>}
                    {delta.levelUps.map((lu, i) => <p key={i} className="text-xs font-medium">🎉 LEVEL UP {lu.from} → {lu.to}</p>)}
                    {delta.currencyChanges.map((c, i) => <p key={i} className="text-xs">💰 {c.currency} {c.amount > 0 ? '+' : ''}{c.amount} (balance {c.balanceAfter})</p>)}
                    {delta.achievementsUnlocked.map((a, i) => <p key={i} className="text-xs">🏆 Achievement: {a.name}</p>)}
                    {delta.challengesCompleted.map((c, i) => <p key={i} className="text-xs">🎯 Challenge completed: {c.name}</p>)}
                    {delta.streak && <p key="streak" className="text-xs">🔥 Streak {delta.streak.key}: current {delta.streak.current} (best {delta.streak.best})</p>}
                    {delta.leaderboardUpdates.map((l, i) => <p key={i} className="text-xs">📊 {l.leaderboard}: score {l.score} rank #{l.rank ?? '?'}</p>)}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* User state snapshot */}
          {state && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Live user state — {state.user.external_id}</CardTitle>
                <CardDescription>The same snapshot the SDK serves via GET /api/v1/users/&#123;id&#125;/state</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Progression */}
                <div className="space-y-2.5">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><GitBranch className="h-3.5 w-3.5" /> Progression</p>
                  {state.progression.map((p) => (
                    <div key={p.track} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">Level {p.level}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{p.xp} XP</span>
                      </div>
                      <Progress value={p.progressPercent} className="h-2" />
                      {p.xpForNextLevel > 0 && (
                        <p className="text-[11px] text-muted-foreground">{p.xpForNextLevel - p.xp} XP to level {p.level + 1}</p>
                      )}
                    </div>
                  ))}
                  {state.progression.length === 0 && <p className="text-xs text-muted-foreground">No XP yet</p>}
                </div>

                {/* Wallets */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><Coins className="h-3.5 w-3.5" /> Wallets</p>
                  {state.wallets.length === 0 && <p className="text-xs text-muted-foreground">Empty — earn via rules</p>}
                  {state.wallets.map((w) => (
                    <div key={w.currency} className="flex items-center justify-between text-sm rounded-lg border px-3 py-1.5">
                      <span className="font-medium">{w.currency}</span>
                      <span className="tabular-nums font-semibold">{w.balance.toLocaleString()}</span>
                    </div>
                  ))}
                </div>

                {/* Challenges */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><Target className="h-3.5 w-3.5" /> Challenges</p>
                  {state.challenges.length === 0 && <p className="text-xs text-muted-foreground">None configured</p>}
                  {state.challenges.slice(0, 5).map((c) => (
                    <div key={c.name} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="truncate">{c.completed ? '✅ ' : ''}{c.name}</span>
                        <span className="text-muted-foreground tabular-nums">{c.progress}/{c.target}</span>
                    </div>
                      <Progress value={c.progressPercent} className="h-1.5" />
                    </div>
                  ))}
                </div>

                {/* Achievements */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><Trophy className="h-3.5 w-3.5" /> Achievements</p>
                  {state.achievements.length === 0 && <p className="text-xs text-muted-foreground">None configured</p>}
                  <div className="flex flex-wrap gap-1.5">
                    {state.achievements.slice(0, 12).map((a) => (
                      <Badge key={a.code} variant={a.unlocked ? 'default' : 'outline'} className={cn('text-[11px] cursor-default', !a.unlocked && 'opacity-50')}>
                        {a.icon ?? '🏅'} {a.name}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Streaks + inventory */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><Flame className="h-3.5 w-3.5" /> Streaks</p>
                  {state.streaks.length === 0 && <p className="text-xs text-muted-foreground">None configured</p>}
                  {state.streaks.map((s) => (
                    <div key={s.key} className="flex items-center justify-between text-sm rounded-lg border px-3 py-1.5">
                      <span className="truncate text-xs">{s.name}</span>
                      <span className="text-xs font-semibold tabular-nums">🔥 {s.current} <span className="text-muted-foreground font-normal">(best {s.best})</span></span>
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><Package className="h-3.5 w-3.5" /> Inventory</p>
                  {state.inventory.length === 0 && <p className="text-xs text-muted-foreground">Empty — items granted via rewards</p>}
                  <div className="flex flex-wrap gap-1.5">
                    {state.inventory.map((i) => (
                      <Badge key={i.code} variant="secondary" className="text-[11px]">{i.name} ×{i.quantity}</Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </DashboardShell>
  )
}
