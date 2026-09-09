'use client'

/**
 * Settings → Environment promotion card (§ Mode C, Phase 5).
 * Dev → staging → production via export→import(overwrite) with dry-run diff.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, ArrowUpRight, Play, FileDiff } from 'lucide-react'
import { apiGet, apiPost, isApiError } from '@/lib/client-api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface PromoteResult {
  dryRun: boolean
  from: string
  to: string
  summary: { create: number; overwrite: number; skip: number; identical: number }
  objects: Array<{ resource: string; naturalKey: string; action: string; reason?: string }>
  applied: boolean
}

export function PromoteCard() {
  const [environments, setEnvironments] = useState<string[]>([])
  const [from, setFrom] = useState('development')
  const [to, setTo] = useState('production')
  const [busy, setBusy] = useState<'dry' | 'apply' | null>(null)
  const [result, setResult] = useState<PromoteResult | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ environments: string[]; current: string }>('/api/admin/promote')
      const envs = data.environments?.length ? data.environments : ['development', 'staging', 'production']
      setEnvironments(envs)
      const current = envs.includes(data.current) ? data.current : envs[0]
      setFrom(current)
      setTo(envs.find((e) => e !== current) ?? current)
    } catch {
      setEnvironments(['development', 'staging', 'production'])
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'dry' : 'apply')
    try {
      const res = await apiPost<PromoteResult>('/api/admin/promote', { from, to, dryRun })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix })
        return
      }
      setResult(res)
      if (dryRun) {
        toast.success('Dry-run complete', { description: `${res.summary.create} create · ${res.summary.overwrite} overwrite · ${res.summary.identical} identical` })
      } else {
        toast.success(`Promoted ${res.from} → ${res.to}`, {
          description: `${res.summary.create} created · ${res.summary.overwrite} overwritten`,
        })
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ArrowUpRight className="h-4 w-4 text-primary" /> Environment Promotion
        </CardTitle>
        <CardDescription>
          Ship configuration between environments — validated, transactional, audited (export → import with overwrite)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">From</span>
            <select
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            >
              {environments.map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          </label>
          <span className="pb-2 text-muted-foreground">→</span>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">To</span>
            <select
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            >
              {environments.filter((e) => e !== from).map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" size="sm" onClick={() => run(true)} disabled={busy !== null || from === to}>
              {busy === 'dry' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDiff className="h-4 w-4 mr-1.5" />}
              Dry-run
            </Button>
            <Button size="sm" onClick={() => run(false)} disabled={busy !== null || from === to}>
              {busy === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 mr-1.5" />}
              Promote
            </Button>
          </div>
        </div>

        {result && (
          <div className="rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap gap-3 mb-2 font-mono text-xs">
              <span className="text-emerald-600">+{result.summary.create} create</span>
              <span className="text-amber-600">~{result.summary.overwrite} overwrite</span>
              <span className="text-muted-foreground">· {result.summary.skip} skip</span>
              <span className="text-muted-foreground">= {result.summary.identical} identical</span>
              <span className={cn('ml-auto', result.applied ? 'text-primary' : 'text-muted-foreground')}>
                {result.dryRun ? 'dry-run' : 'applied ✓'}
              </span>
            </div>
            <div className="max-h-44 overflow-y-auto font-mono text-[11px] space-y-0.5">
              {result.objects.filter((o) => o.action !== 'identical').slice(0, 50).map((o, i) => (
                <div key={i} className="flex gap-2">
                  <span className={cn(o.action === 'create' && 'text-emerald-600', o.action === 'overwrite' && 'text-amber-600', o.action === 'skip' && 'text-red-500')}>
                    {o.action === 'create' ? '+' : o.action === 'overwrite' ? '~' : '!'}
                  </span>
                  <span className="w-32 text-muted-foreground">{o.resource}</span>
                  <span className="truncate">{o.naturalKey}</span>
                </div>
              ))}
              {result.objects.filter((o) => o.action !== 'identical').length === 0 && (
                <p className="text-muted-foreground">no changes — environments are in sync</p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
