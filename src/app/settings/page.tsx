'use client'

/**
 * Settings page — API keys management + integration snippets.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, RefreshCw, Copy, KeyRound, Ban, CheckCircle2 } from 'lucide-react'
import { apiGet, apiPost, apiDelete, isApiError, formatRelative } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { ImportExportCard } from '@/components/settings/io-card'
import { SsoCard } from '@/components/settings/sso-card'
import { ScimCard } from '@/components/settings/scim-card'
import { PromoteCard } from '@/components/settings/promote-card'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  scopes: string[]
  status: string
  lastUsedAt: string | null
  createdAt: string
}

export default function SettingsPage() {
  const auth = useAuthGuard()
  const [keys, setKeys] = useState<ApiKeyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [freshKey, setFreshKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ keys: ApiKeyRow[] }>('/api/admin/apikeys/list')
      setKeys(data.keys)
    } catch {
      toast.error('Failed to load API keys')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status, load])

  const create = async () => {
    if (!newName.trim()) {
      toast.error('Give the key a name')
      return
    }
    setCreating(true)
    try {
      const res = await apiPost<{ key: { key: string } }>('/api/admin/apikeys/list', { name: newName.trim() })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix })
        return
      }
      setFreshKey(res.key.key)
      setNewName('')
      toast.success('API key created — copy it now, it is shown only once')
      load()
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (id: string) => {
    const res = await apiDelete(`/api/admin/apikeys/list?id=${id}`)
    if (isApiError(res)) {
      toast.error(res.error.message)
      return
    }
    toast.success('Key revoked')
    load()
  }

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="Settings" subtitle="Platform configuration">
        <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      </DashboardShell>
    )
  }
  if (auth.status !== 'authenticated') return null

  return (
    <DashboardShell title="Settings" subtitle="API keys, SDK integration and platform info">
      <div className="space-y-4 max-w-4xl">
        {/* New key banner */}
        {freshKey && (
          <Card className="border-primary/40 bg-primary/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" /> New API key created
              </CardTitle>
              <CardDescription>Copy it now — the full key is never shown again.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-background border rounded-lg px-3 py-2 overflow-x-auto">{freshKey}</code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard.writeText(freshKey)
                    toast.success('Copied to clipboard')
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* API keys */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle className="text-base flex items-center gap-2"><KeyRound className="h-4 w-4 text-primary" /> API Keys</CardTitle>
                <CardDescription>SDK and server-to-server authentication, scoped per environment</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={load} aria-label="Refresh keys">
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Key name (e.g. Web SDK — production)" aria-label="New key name" />
              <Button onClick={create} disabled={creating}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
                Create key
              </Button>
            </div>

            <div className="space-y-1.5">
              {loading && keys.length === 0 ? (
                <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : keys.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No API keys yet — create one to use the SDK or public API</p>
              ) : (
                keys.map((k) => (
                  <div key={k.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium truncate">{k.name}</p>
                        <Badge variant="outline" className={cn('text-[10px]', k.status === 'active' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : 'bg-red-500/10 text-red-600 border-red-500/30')}>
                          {k.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">{k.prefix}••••••••</p>
                      <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                        scopes: {k.scopes.join(', ')} · {k.lastUsedAt ? `last used ${formatRelative(k.lastUsedAt)}` : 'never used'}
                      </p>
                    </div>
                    {k.status === 'active' && (
                      <Button variant="ghost" size="icon" className="text-destructive" onClick={() => revoke(k.id)} aria-label={`Revoke ${k.name}`}>
                        <Ban className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Import / Export (§59-60) */}
        <ImportExportCard />

        {/* SSO / OIDC (§ Phase 5) */}
        <SsoCard />

        {/* SCIM provisioning (§ Phase 5) */}
        <ScimCard baseUrl={typeof window !== 'undefined' ? window.location.origin : ''} />

        {/* Environment promotion (§ Mode C) */}
        <PromoteCard />

        {/* Integration snippet */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">SDK quick start</CardTitle>
            <CardDescription>Drop into any web app — the same loop the Playground simulates</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">1. Install & initialize (web SDK from /sdk/web)</p>
              <pre className="text-xs font-mono bg-muted rounded-lg p-3 overflow-x-auto">{`import { GamificationOG } from '@gamificationog/sdk'

const gog = new GamificationOG({ apiKey: 'gog_your_key_here' })`}</pre>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">2. Identify the user and track events</p>
              <pre className="text-xs font-mono bg-muted rounded-lg p-3 overflow-x-auto">{`await gog.identify('user_123', { plan: 'free' })

const result = await gog.track('task.completed', { count: 1 })
// result.stateDelta → XP, level ups, currency, achievements...
// result.traceId → full decision trace`}</pre>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">3. Render state (leaderboards, wallets, challenges)</p>
              <pre className="text-xs font-mono bg-muted rounded-lg p-3 overflow-x-auto">{`const state = await gog.getUserState('user_123')
const board = await gog.getLeaderboard('weekly_xp', 50)`}</pre>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Raw API (any language — HTTP is the universal fallback)</p>
              <pre className="text-xs font-mono bg-muted rounded-lg p-3 overflow-x-auto">{`curl -X POST {BASE_URL}/api/v1/events \\
  -H "Authorization: Bearer gog_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"event_type":"task.completed","external_user_id":"user_123","payload":{"count":1}}'`}</pre>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  )
}
