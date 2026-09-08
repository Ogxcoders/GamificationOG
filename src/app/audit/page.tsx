'use client'

/**
 * Audit Log page (Section 96) — immutable admin mutation records.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, ScrollText } from 'lucide-react'
import { apiGet, formatRelative } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface AuditEntry {
  id: string
  actorType: string
  actorId: string | null
  action: string
  targetType: string
  targetId: string | null
  before: unknown
  after: unknown
  reason: string | null
  createdAt: string
}

const ACTOR_COLORS: Record<string, string> = {
  human: 'bg-primary/10 text-primary border-primary/30',
  system: 'bg-zinc-500/10 text-zinc-600 border-zinc-500/30',
  plugin: 'bg-violet-500/10 text-violet-600 border-violet-500/30',
  ai: 'bg-pink-500/10 text-pink-600 border-pink-500/30',
  automation: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
}

export default function AuditPage() {
  const auth = useAuthGuard()
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ entries: AuditEntry[] }>('/api/admin/audit/list?limit=150')
      setEntries(data.entries)
    } catch {
      toast.error('Failed to load audit log')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status, load])

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="Audit Log" subtitle="Immutable mutation records">
        <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      </DashboardShell>
    )
  }
  if (auth.status !== 'authenticated') return null

  return (
    <DashboardShell
      title="Audit Log"
      subtitle="Who changed what, when — with before/after state. Immutable by design."
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-[11px]">{entries.length} entries</Badge>
          <div className="ml-auto">
            <Button variant="outline" size="sm" onClick={load} aria-label="Refresh">
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
          </div>
        </div>

        {loading && entries.length === 0 ? (
          <Card><CardContent className="py-16 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></CardContent></Card>
        ) : entries.length === 0 ? (
          <Card><CardContent className="py-16 text-center">
            <ScrollText className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No audit entries yet</p>
          </CardContent></Card>
        ) : (
          <div className="space-y-1.5">
            {entries.map((e) => (
              <Card key={e.id} className="overflow-hidden">
                <button
                  className="w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors"
                  onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                  aria-expanded={expanded === e.id}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className={cn('text-[10px]', ACTOR_COLORS[e.actorType] ?? '')}>{e.actorType}</Badge>
                    <code className="text-xs font-mono">{e.action}</code>
                    <span className="text-xs text-muted-foreground">on {e.targetType}</span>
                    <span className="text-[11px] text-muted-foreground/60 ml-auto">{formatRelative(e.createdAt)}</span>
                  </div>
                </button>
                {expanded === e.id && (
                  <div className="border-t bg-muted/30 px-4 py-3 space-y-2">
                    {e.reason && <p className="text-xs text-muted-foreground">Reason: {e.reason}</p>}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {e.before !== null && e.before !== undefined && (
                        <div>
                          <p className="text-[11px] font-semibold text-muted-foreground uppercase mb-1">Before</p>
                          <pre className="text-[11px] font-mono bg-background rounded-lg border p-2 overflow-x-auto max-h-40 overflow-y-auto">{JSON.stringify(e.before, null, 2)}</pre>
                        </div>
                      )}
                      {e.after !== null && e.after !== undefined && (
                        <div>
                          <p className="text-[11px] font-semibold text-muted-foreground uppercase mb-1">After</p>
                          <pre className="text-[11px] font-mono bg-background rounded-lg border p-2 overflow-x-auto max-h-40 overflow-y-auto">{JSON.stringify(e.after, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </DashboardShell>
  )
}
