'use client'

/**
 * Experiments & Flags & Remote Config page (Sections 35, 36).
 * Three tabs over the same targeting infrastructure.
 */
import { useEffect, useState, useCallback } from 'react'
import { Loader2, Plus, Trash2, RefreshCw, FlaskConical, Flag, Settings2 } from 'lucide-react'
import { apiGet, apiPost, apiPatch, apiDelete, isApiError, tryParseJson, formatRelative } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface Experiment { id: string; key: string; name: string; description: string | null; variantsJson: string; trafficPercent: number; status: string }
interface FeatureFlag { id: string; key: string; description: string | null; enabled: boolean; rolloutPercent: number; segmentsJson: string; status: string }
interface RemoteConfig { id: string; key: string; valueType: string; valueJson: string; status: string }

export default function ExperimentsPage() {
  const auth = useAuthGuard()
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [flags, setFlags] = useState<FeatureFlag[]>([])
  const [configs, setConfigs] = useState<RemoteConfig[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [exp, fl, cfg] = await Promise.all([
        apiGet<{ items: Experiment[] }>('/api/admin/experiments'),
        apiGet<{ items: FeatureFlag[] }>('/api/admin/flags'),
        apiGet<{ items: RemoteConfig[] }>('/api/admin/remote-configs'),
      ])
      setExperiments(exp.items)
      setFlags(fl.items)
      setConfigs(cfg.items)
    } catch {
      toast.error('Failed to load experiments data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status, load])

  const toggleFlag = async (flag: FeatureFlag, enabled: boolean) => {
    setFlags((prev) => prev.map((f) => (f.id === flag.id ? { ...f, enabled } : f)))
    const res = await apiPatch(`/api/admin/flags/${flag.id}`, { enabled })
    if (isApiError(res)) {
      toast.error(res.error.message)
      load()
    } else {
      toast.success(`Flag "${flag.key}" ${enabled ? 'enabled' : 'disabled'}`)
    }
  }

  const createDemoExperiment = async () => {
    const key = `exp_${Math.random().toString(36).slice(2, 7)}`
    const res = await apiPost('/api/admin/experiments', {
      key,
      name: `New Experiment ${key.slice(-4)}`,
      variantsJson: JSON.stringify([
        { key: 'control', name: 'Control', weight: 50 },
        { key: 'treatment', name: 'Treatment', weight: 50 },
      ]),
      trafficPercent: 100,
      status: 'running',
    })
    if (isApiError(res)) {
      toast.error(res.error.message, { description: res.error.fix })
      return
    }
    toast.success('Experiment created')
    load()
  }

  const createDemoFlag = async () => {
    const key = `new_feature_${Math.random().toString(36).slice(2, 6)}`
    const res = await apiPost('/api/admin/flags', {
      key,
      description: 'New feature gate',
      enabled: false,
      rolloutPercent: 100,
    })
    if (isApiError(res)) {
      toast.error(res.error.message, { description: res.error.fix })
      return
    }
    toast.success('Flag created')
    load()
  }

  const createDemoConfig = async () => {
    const key = `config_${Math.random().toString(36).slice(2, 6)}`
    const res = await apiPost('/api/admin/remote-configs', {
      key,
      valueType: 'string',
      valueJson: JSON.stringify('value'),
    })
    if (isApiError(res)) {
      toast.error(res.error.message, { description: res.error.fix })
      return
    }
    toast.success('Remote config created')
    load()
  }

  const remove = async (resource: string, id: string, label: string) => {
    const res = await apiDelete(`/api/admin/${resource}/${id}`)
    if (isApiError(res)) {
      toast.error(res.error.message)
      return
    }
    toast.success(`${label} removed`)
    load()
  }

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="Experiments & Flags" subtitle="Targeting infrastructure">
        <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      </DashboardShell>
    )
  }
  if (auth.status !== 'authenticated') return null

  return (
    <DashboardShell
      title="Experiments & Flags"
      subtitle="A/B experiments, feature gates, and remote configuration"
    >
      <Tabs defaultValue="experiments" className="space-y-4">
        <TabsList>
          <TabsTrigger value="experiments" className="gap-1.5"><FlaskConical className="h-3.5 w-3.5" /> Experiments</TabsTrigger>
          <TabsTrigger value="flags" className="gap-1.5"><Flag className="h-3.5 w-3.5" /> Feature Flags</TabsTrigger>
          <TabsTrigger value="configs" className="gap-1.5"><Settings2 className="h-3.5 w-3.5" /> Remote Config</TabsTrigger>
        </TabsList>

        <TabsContent value="experiments" className="space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground flex-1">
              Deterministic, sticky variant assignment per user. Traffic gates respect percentage rollouts.
            </p>
            <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-4 w-4" /></Button>
            <Button size="sm" onClick={createDemoExperiment}><Plus className="h-4 w-4 mr-1.5" /> New experiment</Button>
          </div>
          {experiments.map((exp) => {
            const variants = tryParseJson(exp.variantsJson, []) as Array<{ key: string; name?: string; weight?: number }>
            return (
              <Card key={exp.id}>
                <CardContent className="p-4 flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-sm">{exp.name}</p>
                      <code className="text-[11px] bg-muted px-1.5 py-0.5 rounded font-mono">{exp.key}</code>
                      <Badge variant="outline" className={cn('text-[10px]', exp.status === 'running' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' : '')}>
                        {exp.status}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">{exp.trafficPercent}% traffic</Badge>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {variants.map((v) => (
                        <Badge key={v.key} variant="outline" className="text-[11px]">
                          {v.key}: {v.weight ?? 0}%
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" className="text-destructive" onClick={() => remove('experiments', exp.id, 'Experiment')} aria-label="Delete experiment">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            )
          })}
          {experiments.length === 0 && !loading && (
            <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No experiments yet</CardContent></Card>
          )}
        </TabsContent>

        <TabsContent value="flags" className="space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground flex-1">
              Gates evaluated per user with deterministic bucketing and segment targeting.
            </p>
            <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-4 w-4" /></Button>
            <Button size="sm" onClick={createDemoFlag}><Plus className="h-4 w-4 mr-1.5" /> New flag</Button>
          </div>
          {flags.map((flag) => (
            <Card key={flag.id}>
              <CardContent className="p-4 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-sm font-mono font-medium">{flag.key}</code>
                    <Badge variant="outline" className="text-[10px]">{flag.rolloutPercent}% rollout</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{flag.description}</p>
                </div>
                <Switch checked={flag.enabled} onCheckedChange={(v) => toggleFlag(flag, v)} aria-label={`Toggle ${flag.key}`} />
                <Button variant="ghost" size="icon" className="text-destructive" onClick={() => remove('flags', flag.id, 'Flag')} aria-label="Delete flag">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
          {flags.length === 0 && !loading && (
            <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No flags yet</CardContent></Card>
          )}
        </TabsContent>

        <TabsContent value="configs" className="space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground flex-1">
              Runtime configuration values served to clients via the flags endpoint.
            </p>
            <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-4 w-4" /></Button>
            <Button size="sm" onClick={createDemoConfig}><Plus className="h-4 w-4 mr-1.5" /> New config</Button>
          </div>
          {configs.map((cfg) => (
            <Card key={cfg.id}>
              <CardContent className="p-4 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-sm font-mono font-medium">{cfg.key}</code>
                    <Badge variant="outline" className="text-[10px]">{cfg.valueType}</Badge>
                  </div>
                  <code className="text-xs text-muted-foreground mt-0.5 block font-mono truncate">
                    {String(tryParseJson(cfg.valueJson, cfg.valueJson))}
                  </code>
                </div>
                <Button variant="ghost" size="icon" className="text-destructive" onClick={() => remove('remote-configs', cfg.id, 'Config')} aria-label="Delete config">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
          {configs.length === 0 && !loading && (
            <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No remote configs yet</CardContent></Card>
          )}
        </TabsContent>
      </Tabs>
    </DashboardShell>
  )
}
