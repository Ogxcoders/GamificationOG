'use client'

/**
 * Events page (Section 10) — live ingestion feed + schema registry.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, Zap, RotateCcw, Search } from 'lucide-react'
import { apiGet, apiPost, isApiError, tryParseJson, formatRelative } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { ResourceCrud } from '@/components/dashboard/resource-crud'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface FeedEvent {
  id: string
  eventId: string
  type: string
  status: string
  source: string
  user: string | null
  payload: Record<string, unknown>
  occurredAt: string
  receivedAt: string
  correlationId: string | null
  hasTrace: boolean
}

const STATUS_COLORS: Record<string, string> = {
  processed: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  received: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  processing: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  failed: 'bg-red-500/10 text-red-600 border-red-500/30',
  duplicate: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/30',
  skipped: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/30',
}

function EventsFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([])
  const [typeCounts, setTypeCounts] = useState<Array<{ type: string; count: number }>>([])
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<FeedEvent | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = typeFilter !== 'all' ? `?type=${encodeURIComponent(typeFilter)}` : ''
      const data = await apiGet<{ events: FeedEvent[]; typeCounts: Array<{ type: string; count: number }> }>(`/api/admin/events/feed${params}&limit=100`)
      setEvents(data.events)
      setTypeCounts(data.typeCounts)
    } catch {
      toast.error('Failed to load events')
    } finally {
      setLoading(false)
    }
  }, [typeFilter])

  useEffect(() => {
    const t = setInterval(load, 8000) // auto-refresh live feed
    load()
    return () => clearInterval(t)
  }, [load])

  const filtered = events.filter((e) => {
    if (query) {
      const q = query.toLowerCase()
      if (!e.type.toLowerCase().includes(q) && !JSON.stringify(e.payload).toLowerCase().includes(q) && !(e.user ?? '').toLowerCase().includes(q)) return false
    }
    return true
  })

  const replay = async (event: FeedEvent) => {
    const res = await apiPost(`/api/admin/events/feed?eventId=${event.id}`)
    if (isApiError(res)) {
      toast.error(res.error.message, { description: res.error.fix })
      return
    }
    toast.success('Event replayed through the pipeline', { description: 'Check Decision Traces for the new trace.' })
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search type, user, payload..." className="pl-9" aria-label="Search events" />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {typeCounts.map((t) => (
              <SelectItem key={t.type} value={t.type}>
                {t.type} ({t.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={load} aria-label="Refresh">
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          <span className="ml-1.5 hidden sm:inline">Refresh</span>
        </Button>
        <Badge variant="secondary" className="text-[11px] ml-auto">{filtered.length} shown · auto-refresh 8s</Badge>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="max-h-[560px] overflow-y-auto">
          {loading && events.length === 0 ? (
            <div className="py-16 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center">
              <Zap className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No events match. Track events via the SDK or <a href="/playground" className="text-primary underline">Playground</a>.</p>
            </div>
          ) : (
            <div className="divide-y">
              {filtered.map((e) => (
                <button
                  key={e.id}
                  onClick={() => setSelected(e)}
                  className="w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors flex items-center gap-3"
                >
                  <Badge variant="outline" className={cn('text-[10px] shrink-0', STATUS_COLORS[e.status] ?? '')}>{e.status}</Badge>
                  <code className="text-xs font-mono truncate flex-1 min-w-0">{e.type}</code>
                  <span className="text-xs text-muted-foreground truncate hidden md:block max-w-[140px]">{e.user ?? '—'}</span>
                  {e.hasTrace && <Badge variant="secondary" className="text-[9px] shrink-0 hidden sm:inline-flex">trace</Badge>}
                  <span className="text-[11px] text-muted-foreground/70 shrink-0 tabular-nums">{formatRelative(e.receivedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Event detail */}
      {selected && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <CardTitle className="text-base font-mono">{selected.type}</CardTitle>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => replay(selected)}>
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Replay
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>Close</Button>
              </div>
            </div>
            <CardDescription>
              event_id {selected.eventId} · user {selected.user ?? '—'} · source {selected.source} · correlation {selected.correlationId?.slice(0, 8) ?? '—'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Payload</p>
            <pre className="text-xs font-mono bg-muted rounded-lg p-3 overflow-x-auto">
              {JSON.stringify(selected.payload, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// Schema registry tab reuses the generic CRUD
function SchemaRegistry() {
  return (
    <ResourceCrud
      resource="event-schemas"
      title="Event Schemas"
      subtitle="Payload contracts validated at the gateway"
      fields={[
        { name: 'name', label: 'Event name', type: 'text', required: true, placeholder: 'task.completed', width: 'half' },
        { name: 'version', label: 'Version', type: 'number', defaultValue: 1, width: 'half' },
        { name: 'description', label: 'Description', type: 'textarea', width: 'full' },
        { name: 'payloadSchemaJson', label: 'Payload schema (JSON)', type: 'json', width: 'full', defaultValue: '{}', hint: 'Property specs: {"count":{"type":"number","required":true,"min":0},"difficulty":{"type":"string","enum":["easy","hard"]}}' },
        { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
          { value: 'draft', label: 'Draft (validation off)' },
          { value: 'active', label: 'Active (validation on)' },
        ], width: 'half' },
      ]}
      columns={[
        { key: 'name', label: 'Event type', render: (item) => <code className="text-xs font-mono">{String(item.name)}</code> },
        { key: 'version', label: 'Version', render: (item) => <span className="text-sm tabular-nums">v{String(item.version)}</span> },
        { key: 'payloadSchemaJson', label: 'Schema', render: (item) => (
          <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap max-w-[360px] truncate">
            {JSON.stringify(tryParseJson(String(item.payloadSchemaJson ?? ''), {})).slice(0, 120)}
          </pre>
        )},
      ]}
    />
  )
}

export default function EventsPage() {
  const auth = useAuthGuard()
  const [tab, setTab] = useState('feed')

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="Events" subtitle="The platform's universal nervous system">
        <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      </DashboardShell>
    )
  }
  if (auth.status !== 'authenticated') return null

  if (tab === 'schemas') return <SchemaRegistry />

  return (
    <DashboardShell title="Events" subtitle="The platform's universal nervous system — ingestion feed and schema registry">
      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="feed" className="gap-1.5"><Zap className="h-3.5 w-3.5" /> Live feed</TabsTrigger>
          <TabsTrigger value="schemas" className="gap-1.5">Schemas</TabsTrigger>
        </TabsList>
        <TabsContent value="feed">
          <EventsFeed />
        </TabsContent>
        <TabsContent value="schemas">
          <div className="text-sm text-muted-foreground">Switched to the schema registry view.</div>
        </TabsContent>
      </Tabs>
    </DashboardShell>
  )
}
