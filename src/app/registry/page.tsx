'use client'

/**
 * Capability Registry page (Section 2.3) — discoverable extension points.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Blocks, Search } from 'lucide-react'
import { apiGet } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { toast } from '@/sonner-bridge'

interface Capability {
  kind: string
  name: string
  domain: string
  description: string
}

export default function RegistryPage() {
  const auth = useAuthGuard()
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [summary, setSummary] = useState<{ total: number; byKind: Record<string, number>; byDomain: Record<string, number> } | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState('all')

  useEffect(() => {
    if (auth.status !== 'authenticated') return
    apiGet<{ registry: Capability[]; summary: { total: number; byKind: Record<string, number>; byDomain: Record<string, number> } }>('/api/admin/registry/list')
      .then((data) => {
        setCapabilities(data.registry)
        setSummary(data.summary)
      })
      .catch(() => toast.error('Failed to load registry'))
      .finally(() => setLoading(false))
  }, [auth.status])

  const filtered = useMemo(() => {
    let list = capabilities
    if (kindFilter !== 'all') list = list.filter((c) => c.kind === kindFilter)
    if (query) {
      const q = query.toLowerCase()
      list = list.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.domain.toLowerCase().includes(q))
    }
    return list
  }, [capabilities, query, kindFilter])

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="Capabilities" subtitle="Extension point registry">
        <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      </DashboardShell>
    )
  }
  if (auth.status !== 'authenticated') return null

  const kinds = Object.keys(summary?.byKind ?? {})

  return (
    <DashboardShell
      title="Capabilities"
      subtitle="The registry of every extension point: object types, events, actions, operators, functions"
    >
      <div className="space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
          <Card>
            <CardContent className="p-4">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Total</p>
              <p className="text-2xl font-bold tabular-nums mt-1">{summary?.total ?? '—'}</p>
            </CardContent>
          </Card>
          {kinds.slice(0, 5).map((kind) => (
            <Card key={kind}>
              <CardContent className="p-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground truncate">{kind.replace(/_/g, ' ')}</p>
                <p className="text-2xl font-bold tabular-nums mt-1">{summary?.byKind[kind] ?? 0}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search capabilities..." className="pl-9" aria-label="Search capabilities" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setKindFilter('all')}
              className={cnButton(kindFilter === 'all')}
            >
              all
            </button>
            {kinds.map((k) => (
              <button key={k} onClick={() => setKindFilter(k)} className={cnButton(kindFilter === k)}>
                {k.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
          <Badge variant="secondary" className="text-[11px] ml-auto">{filtered.length} shown</Badge>
        </div>

        {/* Grid */}
        {loading ? (
          <Card><CardContent className="py-16 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {filtered.map((c) => (
              <div key={`${c.kind}:${c.name}`} className="rounded-xl border bg-card px-4 py-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-sm font-mono font-medium truncate">{c.name}</code>
                  <Badge variant="outline" className="text-[10px] ml-auto shrink-0">{c.domain}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{c.description}</p>
              </div>
            ))}
            {filtered.length === 0 && (
              <Card className="md:col-span-2 xl:col-span-3"><CardContent className="py-12 text-center">
                <Blocks className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No capabilities match the filters</p>
              </CardContent></Card>
            )}
          </div>
        )}
      </div>
    </DashboardShell>
  )
}

function cnButton(active: boolean): string {
  return [
    'text-xs px-2.5 py-1 rounded-md border transition-colors',
    active ? 'bg-primary/10 border-primary/40 text-primary font-medium' : 'hover:bg-muted text-muted-foreground',
  ].join(' ')
}
