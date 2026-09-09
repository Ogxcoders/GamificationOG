'use client'

/**
 * Packs page — game design pack catalog (Section 57).
 * Browse reusable behavior bundles, preview what they would create
 * (with conflict detection), install / uninstall in one click.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, Package, CheckCircle2, Eye, Trash2, GitBranch, Trophy, Flame, BarChart3 } from 'lucide-react'
import { apiGet, apiPost, isApiError } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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

interface PreviewObject {
  resource: string
  summary: string
  key: string
  status: 'create' | 'conflict'
  conflictReason?: string
}

interface PackPreview {
  slug: string
  name: string
  version: string
  installed: boolean
  objects: PreviewObject[]
  counts: Record<string, number>
  conflicts: number
}

const RESOURCE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  rules: GitBranch,
  achievements: Trophy,
  streaks: Flame,
  leaderboards: BarChart3,
}

const CATEGORY_LABELS: Record<string, string> = {
  streaks: 'Streaks',
  productivity: 'Productivity',
  learning: 'Learning',
  community: 'Community',
  referral: 'Referral',
  competition: 'Competition',
  loyalty: 'Loyalty',
  rpg: 'RPG',
}

export default function PacksPage() {
  const auth = useAuthGuard()
  const [packs, setPacks] = useState<PackRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<PackPreview | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [scope, setScope] = useState<{ projectName?: string; environmentName?: string }>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ packs: PackRow[]; scope: { projectName: string; environmentName: string } }>('/api/admin/packs')
      setPacks(data.packs ?? [])
      setScope(data.scope ?? {})
    } catch (e) {
      const payload = (e as { payload?: unknown }).payload
      if (isApiError(payload)) {
        toast.error(payload.error.message, { description: payload.error.fix })
      } else {
        toast.error(e instanceof Error ? e.message : 'Failed to load packs')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status, load])

  const showPreview = async (slug: string) => {
    setBusy(slug)
    try {
      const res = await apiPost<{ preview: PackPreview }>('/api/admin/packs', { slug, action: 'preview' })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
        return
      }
      setPreview(res.preview)
      setPreviewOpen(true)
    } finally {
      setBusy(null)
    }
  }

  const install = async (slug: string) => {
    setBusy(slug)
    try {
      const res = await apiPost<{ result: { installed: number } }>('/api/admin/packs', { slug, action: 'install' })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
        return
      }
      toast.success('Pack installed', {
        description: `${res.result.installed} objects materialized in ${scope.environmentName ?? 'this environment'} — validated and audited.`,
      })
      setPreviewOpen(false)
      load()
    } finally {
      setBusy(null)
    }
  }

  const uninstall = async (slug: string) => {
    setBusy(slug)
    try {
      const res = await apiPost<{ result: { removedClean: number; archived: number } }>('/api/admin/packs', { slug, action: 'uninstall' })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
        return
      }
      toast.success('Pack uninstalled', {
        description: `${res.result.removedClean} objects removed cleanly, ${res.result.archived} modified objects archived (your edits preserved).`,
      })
      load()
    } finally {
      setBusy(null)
    }
  }

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="Packs" subtitle="Reusable game design bundles">
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </DashboardShell>
    )
  }

  if (auth.status !== 'authenticated') return null

  const installedCount = packs.filter((p) => p.installedAt).length

  return (
    <DashboardShell title="Packs" subtitle="Reusable game design bundles">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground max-w-3xl">
          Packs are curated behavior bundles — rules, achievements, streaks, and leaderboards that work
          together. Preview shows exactly what would be created with conflict detection; installs go
          through the same validation as manual configuration and are fully audited. Uninstalling
          archives active objects (lifecycle-safe).
        </p>

        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-[11px]">{packs.length} packs available</Badge>
          <Badge variant="outline" className="text-[11px] text-emerald-600 border-emerald-500/30">
            <CheckCircle2 className="h-3 w-3 mr-1" /> {installedCount} installed
          </Badge>
          <Button variant="outline" size="sm" className="ml-auto" onClick={load} aria-label="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {packs.map((pack) => {
              const installed = pack.installedAt !== null
              return (
                <Card key={pack.slug} className={cn('flex flex-col', installed && 'border-emerald-500/40')}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className={cn(
                          'h-8 w-8 rounded-lg flex items-center justify-center',
                          installed ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground',
                        )}>
                          <Package className="h-4 w-4" />
                        </div>
                        <div>
                          <CardTitle className="text-sm">{pack.name}</CardTitle>
                          <p className="text-[11px] text-muted-foreground">
                            {CATEGORY_LABELS[pack.category] ?? pack.category} · v{pack.version}
                          </p>
                        </div>
                      </div>
                      {installed && (
                        <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-500/30 shrink-0">
                          <CheckCircle2 className="h-3 w-3 mr-1" /> Installed
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="pb-3 flex-1">
                    <CardDescription className="text-xs leading-relaxed mb-3">{pack.description}</CardDescription>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(pack.counts).map(([resource, count]) =>
                        count > 0 ? (
                          <Badge key={resource} variant="secondary" className="text-[10px] gap-1">
                            {(() => {
                              const Icon = RESOURCE_ICONS[resource] ?? GitBranch
                              return <Icon className="h-3 w-3" />
                            })()}
                            {count} {resource}
                          </Badge>
                        ) : null,
                      )}
                    </div>
                  </CardContent>
                  <CardFooter className="flex gap-2 pt-0">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => showPreview(pack.slug)} disabled={busy === pack.slug}>
                      {busy === pack.slug ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Eye className="h-3.5 w-3.5 mr-1.5" />}
                      Preview
                    </Button>
                    {installed ? (
                      <Button variant="outline" size="sm" className="flex-1 text-destructive hover:text-destructive" onClick={() => uninstall(pack.slug)} disabled={busy === pack.slug}>
                        <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Uninstall
                      </Button>
                    ) : (
                      <Button size="sm" className="flex-1" onClick={() => install(pack.slug)} disabled={busy === pack.slug}>
                        {busy === pack.slug && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                        Install
                      </Button>
                    )}
                  </CardFooter>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Preview dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-4 w-4" />
              {preview?.name} — preview
            </DialogTitle>
            <DialogDescription>
              {preview?.conflicts === 0
                ? 'All objects validated cleanly. Installing creates exactly these objects:'
                : `${preview?.conflicts} conflict(s) detected — install will be blocked until they are resolved:`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            {preview?.objects.map((obj, i) => {
              const Icon = RESOURCE_ICONS[obj.resource] ?? GitBranch
              return (
                <div
                  key={i}
                  className={cn(
                    'flex items-start gap-3 rounded-lg border p-3',
                    obj.status === 'conflict' ? 'border-amber-500/40 bg-amber-500/5' : 'bg-muted/30',
                  )}
                >
                  <Icon className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{obj.summary}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {obj.resource.replace(/s$/, '')} · key: <code className="font-mono">{obj.key}</code>
                    </p>
                    {obj.conflictReason && (
                      <p className="text-[11px] text-amber-600 mt-1">{obj.conflictReason}</p>
                    )}
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-[10px] shrink-0',
                      obj.status === 'conflict'
                        ? 'text-amber-600 border-amber-500/30'
                        : 'text-emerald-600 border-emerald-500/30',
                    )}
                  >
                    {obj.status === 'conflict' ? 'conflict' : 'will create'}
                  </Badge>
                </div>
              )
            })}
            {preview && preview.objects.length === 0 && (
              <p className="text-sm text-muted-foreground py-8 text-center">This pack contains no objects.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>Close</Button>
            {preview && !preview.installed && (
              <Button
                onClick={() => install(preview.slug)}
                disabled={busy === preview.slug || preview.conflicts > 0}
              >
                {busy === preview.slug && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Install {preview.counts.rules + preview.counts.achievements + preview.counts.streaks + preview.counts.leaderboards} objects
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardShell>
  )
}
