'use client'

/**
 * Settings → SCIM provisioning card (§ Phase 5).
 * Issue/revoke SCIM bearer tokens; shows the endpoint URLs IdP admins need.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, RefreshCw, UsersRound, Ban, Copy, CheckCircle2 } from 'lucide-react'
import { apiGet, apiPost, apiDelete, isApiError, formatRelative } from '@/lib/client-api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface ScimTokenRow {
  id: string
  name: string
  prefix: string
  status: string
  lastUsedAt: string | null
  createdAt: string
}

export function ScimCard({ baseUrl }: { baseUrl: string }) {
  const [tokens, setTokens] = useState<ScimTokenRow[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [freshToken, setFreshToken] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ tokens: ScimTokenRow[] }>('/api/admin/scim/tokens')
      setTokens(data.tokens ?? [])
    } catch {
      toast.error('Failed to load SCIM tokens')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const create = async () => {
    if (!newName.trim()) {
      toast.error('Give the token a name')
      return
    }
    setBusy(true)
    try {
      const res = await apiPost<{ token: { token: string } }>('/api/admin/scim/tokens', { name: newName.trim() })
      if (isApiError(res)) {
        toast.error(res.error.message)
        return
      }
      setFreshToken(res.token.token)
      setNewName('')
      toast.success('SCIM token created — copy it now, it is shown only once')
      load()
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    const res = await apiDelete(`/api/admin/scim/tokens?id=${id}`)
    if (isApiError(res)) {
      toast.error(res.error.message)
      return
    }
    toast.success('Token revoked')
    load()
  }

  const scimBase = `${baseUrl}/api/scim/v2`

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2"><UsersRound className="h-4 w-4 text-primary" /> SCIM Provisioning</CardTitle>
            <CardDescription>Automated user directory sync from your IdP (Okta, Entra ID, JumpCloud…)</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load} aria-label="Refresh SCIM tokens">
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {freshToken && (
          <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2">
            <p className="text-sm font-medium flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" /> New SCIM token</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-background border rounded-lg px-3 py-2 overflow-x-auto">{freshToken}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(freshToken)
                  toast.success('Copied to clipboard')
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        <div className="grid gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-24 shrink-0">Users URL</span>
            <code className="font-mono bg-muted rounded px-2 py-1 overflow-x-auto">{scimBase}/Users</code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-24 shrink-0">Groups URL</span>
            <code className="font-mono bg-muted rounded px-2 py-1 overflow-x-auto">{scimBase}/Groups</code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-24 shrink-0">Auth</span>
            <code className="font-mono bg-muted rounded px-2 py-1">Authorization: Bearer &lt;token&gt;</code>
          </div>
        </div>

        <div className="flex gap-2">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Token name (e.g. Okta SCIM app)" aria-label="New SCIM token name" />
          <Button onClick={create} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
            Issue token
          </Button>
        </div>

        <div className="space-y-1.5">
          {loading && tokens.length === 0 ? (
            <div className="py-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : tokens.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No SCIM tokens yet — issue one and paste it into your IdP&rsquo;s SCIM app</p>
          ) : (
            tokens.map((t) => (
              <div key={t.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium truncate">{t.name}</p>
                    <Badge variant="outline" className={cn('text-[10px]', t.status === 'active' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : 'bg-red-500/10 text-red-600 border-red-500/30')}>
                      {t.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">{t.prefix}••••</p>
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                    {t.lastUsedAt ? `last used ${formatRelative(t.lastUsedAt)}` : 'never used'}
                  </p>
                </div>
                {t.status === 'active' && (
                  <Button variant="ghost" size="icon" className="text-destructive" onClick={() => revoke(t.id)} aria-label={`Revoke ${t.name}`}>
                    <Ban className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
