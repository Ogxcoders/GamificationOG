'use client'

/**
 * Marketplace page (§ Phase 5) — the private registry of installable
 * capability: game design packs (§57 behavior bundles) + plugins
 * (§54 extension modules with validated manifests, trust levels and
 * permission disclosure). One surface, one install story.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, Package, Puzzle, ShieldCheck, Lock, Power, Trash2, Download, CheckCircle2 } from 'lucide-react'
import { apiGet, apiPost, isApiError } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface PackRow {
  slug: string
  name: string
  description: string
  category: string
  version: string
  counts: { rules: number; achievements: number; streaks: number; leaderboards: number }
  installedAt: string | null
}

interface PluginRow {
  id: string
  name: string
  version: string
  description: string
  trust: string
  requires: string[]
  provides: string[]
  permissions: string[]
  actions: Array<{ type: string; description: string }>
  events: Array<{ name: string; description?: string }>
  installed: boolean
  status: string | null
}

const TRUST_STYLES: Record<string, string> = {
  'first-party': 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  verified: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  trusted: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/30',
  sandboxed: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  untrusted: 'bg-red-500/10 text-red-600 border-red-500/30',
}

export default function MarketplacePage() {
  const auth = useAuthGuard()
  const [packs, setPacks] = useState<PackRow[]>([])
  const [plugins, setPlugins] = useState<PluginRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [packData, pluginData] = await Promise.all([
        apiGet<{ packs: PackRow[] }>('/api/admin/packs'),
        apiGet<{ plugins: PluginRow[] }>('/api/admin/plugins'),
      ])
      setPacks(packData.packs ?? [])
      setPlugins(pluginData.plugins ?? [])
    } catch (e) {
      toast.error('Failed to load marketplace')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status, load])

  const pluginAction = async (pluginId: string, action: 'install' | 'enable' | 'disable' | 'uninstall') => {
    setBusy(pluginId + action)
    try {
      const res = await apiPost<{ registeredActions?: string[] }>('/api/admin/plugins', { pluginId, action })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
        return
      }
      const registered = res.registeredActions ?? []
      toast.success(
        action === 'install' ? 'Plugin installed & enabled' : action === 'uninstall' ? 'Plugin uninstalled' : `Plugin ${action}d`,
        { description: registered.length > 0 ? `Actions registered: ${registered.join(', ')}` : undefined },
      )
      load()
    } finally {
      setBusy(null)
    }
  }

  const installPack = async (slug: string) => {
    setBusy(slug)
    try {
      const res = await apiPost('/api/admin/packs', { slug, action: 'install' })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
        return
      }
      toast.success('Pack installed')
      load()
    } finally {
      setBusy(null)
    }
  }

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="Marketplace" subtitle="Private capability registry">
        <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      </DashboardShell>
    )
  }
  if (auth.status !== 'authenticated') return null

  const installedPacks = packs.filter((p) => p.installedAt)
  const installedPlugins = plugins.filter((p) => p.installed)

  return (
    <DashboardShell
      title="Marketplace"
      subtitle={`Private registry — ${packs.length} packs · ${plugins.length} plugins · ${installedPacks.length} packs installed · ${installedPlugins.length} plugins installed`}
    >
      <div className="flex justify-end mb-4">
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* ---------- Plugins (§54) ---------- */}
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
        <Puzzle className="h-4 w-4" /> Plugins — extension modules
      </h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 mb-8">
        {plugins.map((p) => (
          <Card key={p.id} className={cn('flex flex-col', p.installed && 'border-primary/40')}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    {p.name}
                    {p.installed && <CheckCircle2 className="h-4 w-4 text-primary" />}
                  </CardTitle>
                  <CardDescription className="font-mono text-[11px] mt-1">{p.id} · v{p.version}</CardDescription>
                </div>
                <Badge variant="outline" className={cn('text-[10px]', TRUST_STYLES[p.trust] ?? '')}>
                  <ShieldCheck className="h-3 w-3 mr-1" />
                  {p.trust}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm flex-1">
              <p className="text-muted-foreground text-xs leading-relaxed">{p.description}</p>

              {p.actions.length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground mb-1">ACTIONS</p>
                  <div className="space-y-1">
                    {p.actions.map((a) => (
                      <div key={a.type} className="text-xs">
                        <code className="font-mono bg-muted rounded px-1.5 py-0.5">{a.type}</code>
                        <p className="text-muted-foreground text-[11px] ml-1.5 inline">{a.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {p.events.length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground mb-1">EVENTS</p>
                  <div className="flex flex-wrap gap-1">
                    {p.events.map((e) => (
                      <code key={e.name} className="text-[11px] font-mono bg-muted rounded px-1.5 py-0.5">{e.name}</code>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <p className="text-[11px] font-medium text-muted-foreground mb-1 flex items-center gap-1">
                  <Lock className="h-3 w-3" /> PERMISSIONS
                </p>
                <div className="flex flex-wrap gap-1">
                  {p.permissions.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">none requested</span>
                  ) : (
                    p.permissions.map((perm) => (
                      <Badge key={perm} variant="secondary" className="text-[10px] font-mono">{perm}</Badge>
                    ))
                  )}
                </div>
              </div>
            </CardContent>
            <CardFooter className="gap-2">
              {!p.installed ? (
                <Button size="sm" className="w-full" onClick={() => pluginAction(p.id, 'install')} disabled={busy !== null}>
                  {busy === p.id + 'install' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
                  Install &amp; enable
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => pluginAction(p.id, p.status === 'enabled' ? 'disable' : 'enable')}
                    disabled={busy !== null}
                  >
                    {busy === p.id + (p.status === 'enabled' ? 'disable' : 'enable') ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Power className={cn('h-4 w-4', p.status === 'enabled' ? 'text-emerald-600' : 'text-muted-foreground')} />
                    )}
                    {p.status === 'enabled' ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => pluginAction(p.id, 'uninstall')}
                    disabled={busy !== null}
                  >
                    {busy === p.id + 'uninstall' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </Button>
                </>
              )}
            </CardFooter>
          </Card>
        ))}
      </div>

      {/* ---------- Packs (§57) ---------- */}
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
        <Package className="h-4 w-4" /> Packs — game design bundles
      </h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {packs.map((p) => {
          const counts = Object.entries(p.counts ?? {}).filter(([, n]) => Number(n) > 0)
          return (
            <Card key={p.slug} className={cn('flex flex-col', p.installedAt && 'border-primary/40')}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      {p.name}
                      {p.installedAt && <CheckCircle2 className="h-4 w-4 text-primary" />}
                    </CardTitle>
                    <CardDescription className="text-[11px] mt-1 capitalize">{p.category} · v{p.version}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                <p className="text-muted-foreground text-xs leading-relaxed">{p.description}</p>
                <div className="flex flex-wrap gap-1 mt-3">
                  {counts.map(([kind, n]) => (
                    <Badge key={kind} variant="secondary" className="text-[10px]">
                      {n} {kind}
                    </Badge>
                  ))}
                </div>
              </CardContent>
              <CardFooter>
                {p.installedAt ? (
                  <Button size="sm" variant="outline" className="w-full" disabled>
                    Installed — manage in Packs
                  </Button>
                ) : (
                  <Button size="sm" className="w-full" onClick={() => installPack(p.slug)} disabled={busy !== null}>
                    {busy === p.slug ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
                    Install
                  </Button>
                )}
              </CardFooter>
            </Card>
          )
        })}
      </div>
    </DashboardShell>
  )
}
