'use client'

/**
 * Settings → SSO (OIDC) connections card (§ Phase 5).
 * Create / list / disable / delete enterprise identity providers.
 * Client secrets are write-only and encrypted at rest.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, RefreshCw, KeyRound, Trash2, Power } from 'lucide-react'
import { apiGet, apiPost, apiPatch, apiDelete, isApiError } from '@/lib/client-api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface SsoConnectionRow {
  id: string
  name: string
  issuer: string
  clientId: string
  clientSecretMasked: string
  scopes: string[]
  domains: string[]
  jitEnabled: boolean
  jitRole: string
  status: string
  createdAt: string
}

export function SsoCard() {
  const [connections, setConnections] = useState<SsoConnectionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    name: '',
    issuer: '',
    clientId: '',
    clientSecret: '',
    domains: '',
    jitRole: 'viewer',
    jitEnabled: true,
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ connections: SsoConnectionRow[] }>('/api/admin/sso/connections')
      setConnections(data.connections ?? [])
    } catch {
      toast.error('Failed to load SSO connections')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const create = async () => {
    if (!form.name.trim() || !form.issuer.trim() || !form.clientId.trim() || !form.clientSecret.trim()) {
      toast.error('Name, issuer, client ID and client secret are required')
      return
    }
    setBusy(true)
    try {
      const res = await apiPost<{ discovery?: { ok: boolean } }>('/api/admin/sso/connections', {
        name: form.name.trim(),
        issuer: form.issuer.trim(),
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret.trim(),
        domains: form.domains
          .split(',')
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
        jitRole: form.jitRole,
        jitEnabled: form.jitEnabled,
      })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix })
        return
      }
      toast.success('SSO connection created — discovery verified', {
        description: 'A "Sign in with …" button now appears on the login page.',
      })
      setForm({ name: '', issuer: '', clientId: '', clientSecret: '', domains: '', jitRole: 'viewer', jitEnabled: true })
      setShowForm(false)
      load()
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (c: SsoConnectionRow) => {
    const res = await apiPatch(`/api/admin/sso/connections?id=${c.id}`, { status: c.status === 'active' ? 'disabled' : 'active' })
    if (isApiError(res)) {
      toast.error(res.error.message)
      return
    }
    toast.success(c.status === 'active' ? 'Connection disabled' : 'Connection enabled')
    load()
  }

  const remove = async (c: SsoConnectionRow) => {
    const res = await apiDelete(`/api/admin/sso/connections?id=${c.id}`)
    if (isApiError(res)) {
      toast.error(res.error.message)
      return
    }
    toast.success('Connection deleted')
    load()
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2"><KeyRound className="h-4 w-4 text-primary" /> Single Sign-On (OIDC)</CardTitle>
            <CardDescription>Enterprise identity providers — authorization-code flow with PKCE, optional JIT provisioning</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={load} aria-label="Refresh SSO connections">
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
            <Button size="sm" onClick={() => setShowForm((v) => !v)}>
              <Plus className="h-4 w-4 mr-1.5" /> Add connection
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {showForm && (
          <div className="rounded-lg border p-4 space-y-3 bg-muted/30">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sso-name">Display name</Label>
                <Input id="sso-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Corporate Okta" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sso-issuer">Issuer URL</Label>
                <Input id="sso-issuer" value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} placeholder="https://accounts.company.com" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sso-client-id">Client ID</Label>
                <Input id="sso-client-id" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} placeholder="oidc-client-id" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sso-secret">Client secret</Label>
                <Input id="sso-secret" type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} placeholder="write-only, encrypted at rest" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sso-domains">Email domains (optional)</Label>
                <Input id="sso-domains" value={form.domains} onChange={(e) => setForm({ ...form, domains: e.target.value })} placeholder="company.com, subsidiary.com" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sso-role">JIT role for new users</Label>
                <select
                  id="sso-role"
                  value={form.jitRole}
                  onChange={(e) => setForm({ ...form, jitRole: e.target.value })}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                >
                  <option value="viewer">viewer</option>
                  <option value="editor">editor</option>
                  <option value="admin">admin</option>
                  <option value="owner">owner</option>
                </select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.jitEnabled} onChange={(e) => setForm({ ...form, jitEnabled: e.target.checked })} />
              Provision unknown users on first login (JIT)
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button size="sm" onClick={create} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Create &amp; verify discovery
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          {loading && connections.length === 0 ? (
            <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : connections.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No SSO connections — connect Okta, Auth0, Keycloak, Google Workspace or any OIDC provider
            </p>
          ) : (
            connections.map((c) => (
              <div key={c.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    <Badge variant="outline" className={cn('text-[10px]', c.status === 'active' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : 'bg-muted text-muted-foreground')}>
                      {c.status}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">{c.jitEnabled ? `JIT: ${c.jitRole}` : 'JIT off'}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">{c.issuer}</p>
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                    client: {c.clientId} · secret {c.clientSecretMasked}
                    {c.domains.length > 0 && ` · domains: ${c.domains.join(', ')}`}
                  </p>
                </div>
                <Button variant="ghost" size="icon" onClick={() => toggle(c)} aria-label="Toggle connection">
                  <Power className={cn('h-4 w-4', c.status === 'active' ? 'text-emerald-600' : 'text-muted-foreground')} />
                </Button>
                <Button variant="ghost" size="icon" className="text-destructive" onClick={() => remove(c)} aria-label={`Delete ${c.name}`}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
