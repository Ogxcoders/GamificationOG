'use client'

/**
 * Settings → Risk engine card (§74 Fraud / Abuse / Anti-Cheat).
 * Review queue for flagged events (hold/reject/throttle) with
 * release / reject / dismiss adjudication, plus the config toggle
 * and thresholds.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, ShieldAlert, ShieldCheck, Check, X, EyeOff } from 'lucide-react'
import { apiGet, apiPost, isApiError } from '@/lib/client-api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface RiskReason { code: string; detail: string; points: number }
interface RiskFlagRow {
  id: string
  eventId: string | null
  eventType: string
  score: number
  decision: string
  reasons: RiskReason[]
  status: string
  resolvedAt: string | null
  result: Record<string, unknown> | null
  createdAt: string
}
interface RiskConfigRow {
  enabled: boolean
  maxEventsPerMinute: number
  maxEventsPerHour: number
  minEventIntervalMs: number
  maxDuplicatePayloads: number
  maxValueStddevs: number
  thresholdThrottle: number
  thresholdHold: number
  thresholdReject: number
}

const DECISION_STYLES: Record<string, string> = {
  throttle: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  hold: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  reject: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
}

export function RiskCard() {
  const [flags, setFlags] = useState<RiskFlagRow[]>([])
  const [counts, setCounts] = useState({ total: 0, open: 0, held: 0, rejected: 0 })
  const [config, setConfig] = useState<RiskConfigRow | null>(null)
  const [configActive, setConfigActive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{
        flags: RiskFlagRow[]
        counts: { total: number; open: number; held: number; rejected: number }
        config: RiskConfigRow
        configActive: boolean
      }>('/api/admin/risk?status=open&limit=25')
      setFlags(data.flags ?? [])
      setCounts(data.counts ?? { total: 0, open: 0, held: 0, rejected: 0 })
      setConfig(data.config ?? null)
      setConfigActive(!!data.configActive)
    } catch {
      /* card stays empty on error */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const saveConfig = async (patch: Partial<RiskConfigRow>) => {
    setSaving(true)
    try {
      const res = await apiPost<{ config: RiskConfigRow }>('/api/admin/risk', patch)
      if (isApiError(res)) {
        toast.error(res.error.message)
        return
      }
      setConfig(res.config)
      setConfigActive(res.config.enabled)
      toast.success('Risk config saved', {
        description: res.config.enabled ? 'Engine armed — suspicious traffic will be flagged.' : 'Engine disabled (fail-open).',
      })
    } finally {
      setSaving(false)
    }
  }

  const resolve = async (id: string, action: 'release' | 'reject' | 'dismiss') => {
    setBusyId(id)
    try {
      const res = await apiPost<{ result: Record<string, unknown> }>(`/api/admin/risk/${id}/resolve`, { action })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix })
        return
      }
      toast.success(
        action === 'release' ? 'Event released — processed normally' : action === 'reject' ? 'Flag rejected — event stays blocked' : 'Flag dismissed',
      )
      load()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          {configActive ? <ShieldCheck className="h-4 w-4 text-primary" /> : <ShieldAlert className="h-4 w-4 text-muted-foreground" />}
          Risk Engine (Anti-Cheat)
        </CardTitle>
        <CardDescription>
          Fraud / abuse detection: velocity, impossible speed, duplicate farming, value anomalies,
          multi-accounting — score-gated allow / throttle / hold / reject with human review
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* config row */}
        <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <Switch
            checked={configActive}
            disabled={saving || !config}
            onCheckedChange={(v) => saveConfig({ enabled: v })}
            aria-label="Toggle risk engine"
          />
          <div className="text-sm">
            <span className="font-medium">{configActive ? 'Armed' : 'Disabled (fail-open)'}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {config ? `throttle≥${config.thresholdThrottle} · hold≥${config.thresholdHold} · reject≥${config.thresholdReject} · ${config.maxEventsPerMinute}/min · dup>${config.maxDuplicatePayloads}` : 'defaults'}
            </span>
          </div>
          <div className="ml-auto flex gap-3 text-xs text-muted-foreground">
            <span><b className="text-foreground">{counts.open}</b> open</span>
            <span><b className="text-foreground">{counts.held}</b> held</span>
            <span><b className="text-foreground">{counts.rejected}</b> auto-rejected</span>
            <span><b className="text-foreground">{counts.total}</b> total</span>
          </div>
        </div>

        {/* review queue */}
        {loading ? (
          <div className="flex items-center justify-center h-16 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin mr-2" /> loading flags…</div>
        ) : flags.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No open flags — traffic looks clean.</p>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {flags.map((f) => (
              <div key={f.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="secondary" className={cn('font-mono', DECISION_STYLES[f.decision])}>{f.decision}</Badge>
                  <span className="font-mono font-medium">score {f.score}</span>
                  <span className="text-muted-foreground font-mono">{f.eventType}</span>
                  <span className="ml-auto text-muted-foreground">{new Date(f.createdAt).toLocaleString()}</span>
                </div>
                <ul className="space-y-1">
                  {f.reasons.map((r, i) => (
                    <li key={i} className="text-xs text-muted-foreground flex gap-2">
                      <span className="font-mono text-amber-600 shrink-0">+{r.points}</span>
                      <span><b className="font-mono text-foreground/80">{r.code}</b> — {r.detail}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  {f.decision === 'hold' && (
                    <Button size="sm" variant="outline" onClick={() => resolve(f.id, 'release')} disabled={busyId === f.id}>
                      {busyId === f.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
                      Release
                    </Button>
                  )}
                  {f.decision === 'hold' && (
                    <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" onClick={() => resolve(f.id, 'reject')} disabled={busyId === f.id}>
                      <X className="h-3.5 w-3.5 mr-1" /> Reject
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => resolve(f.id, 'dismiss')} disabled={busyId === f.id}>
                    <EyeOff className="h-3.5 w-3.5 mr-1" /> Dismiss
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
