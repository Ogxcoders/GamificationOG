'use client'

/**
 * GamificationOG — Generic Resource CRUD (configuration-first UI).
 * All domain objects (rules, challenges, achievements, streaks, rewards,
 * currencies, items, leaderboards, segments, experiments, flags, schemas)
 * share the same list + create/edit dialog driven by field descriptors.
 */
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Pencil, Trash2, Loader2, RefreshCw, Search, Copy } from 'lucide-react'
import { apiGet, apiPost, apiPatch, apiDelete, isApiError, tryParseJson, formatRelative } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Field descriptors — declarative form schema per resource
// ---------------------------------------------------------------------------
export interface FieldDef {
  name: string
  label: string
  type: 'text' | 'number' | 'textarea' | 'json' | 'select' | 'boolean' | 'date'
  options?: Array<{ value: string; label: string }>
  placeholder?: string
  hint?: string
  required?: boolean
  defaultValue?: unknown
  width?: 'full' | 'half'
}

export interface ColumnDef {
  key: string
  label: string
  render?: (item: Record<string, unknown>) => ReactNode
}

export interface ResourceCrudProps {
  resource: string // API path segment under /api/admin/
  title: string
  subtitle: string
  description?: string
  fields: FieldDef[]
  columns: ColumnDef[]
  emptyMessage?: string
}

type FormState = Record<string, unknown>

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  published: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  draft: 'bg-zinc-500/10 text-zinc-600 border-zinc-500/30',
  paused: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  archived: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/30',
  scheduled: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn('text-[11px]', STATUS_COLORS[status] ?? 'bg-zinc-500/10 text-zinc-500 border-zinc-500/30')}>
      {status}
    </Badge>
  )
}

export function ResourceCrud(props: ResourceCrudProps) {
  const auth = useAuthGuard()
  const [items, setItems] = useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>({})
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Record<string, unknown> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ items: Array<Record<string, unknown>> }>(`/api/admin/${props.resource}`)
      setItems(data.items ?? [])
    } catch (e) {
      const payload = (e as { payload?: unknown }).payload
      if (isApiError(payload)) {
        toast.error(payload.error.message, { description: payload.error.fix })
      } else {
        toast.error(e instanceof Error ? e.message : 'Failed to load')
      }
    } finally {
      setLoading(false)
    }
  }, [props.resource])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status, load])

  const filtered = useMemo(() => {
    if (!query) return items
    const q = query.toLowerCase()
    return items.filter((item) => JSON.stringify(item).toLowerCase().includes(q))
  }, [items, query])

  const openCreate = () => {
    const initial: FormState = {}
    for (const f of props.fields) {
      initial[f.name] = f.defaultValue ?? (f.type === 'boolean' ? false : f.type === 'number' ? undefined : '')
    }
    setForm(initial)
    setEditingId(null)
    setDialogOpen(true)
  }

  const openEdit = (item: Record<string, unknown>) => {
    const initial: FormState = {}
    for (const f of props.fields) {
      initial[f.name] = item[f.name] ?? f.defaultValue ?? ''
    }
    setForm(initial)
    setEditingId(String(item.id))
    setDialogOpen(true)
  }

  const duplicate = async (item: Record<string, unknown>) => {
    const data: Record<string, unknown> = {}
    for (const f of props.fields) {
      data[f.name] = item[f.name]
    }
    // adjust unique codes
    if ('code' in data && typeof data.code === 'string') data.code = data.code + '-copy-' + Math.random().toString(36).slice(2, 6)
    if ('key' in data && typeof data.key === 'string') data.key = data.key + '-copy-' + Math.random().toString(36).slice(2, 6)
    if ('name' in data && typeof data.name === 'string' && 'code' in data) data.name = data.name + ' (copy)'
    const res = await apiPost(`/api/admin/${props.resource}`, data)
    if (isApiError(res)) {
      toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
    } else {
      toast.success('Duplicated')
      load()
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {}
      for (const f of props.fields) {
        const value = form[f.name]
        if (value === '' || value === undefined) {
          if (f.required) {
            toast.error(`"${f.label}" is required`)
            return
          }
          continue
        }
        if (f.type === 'number') payload[f.name] = Number(value)
        else payload[f.name] = value
      }

      const res = editingId
        ? await apiPatch(`/api/admin/${props.resource}/${editingId}`, payload)
        : await apiPost(`/api/admin/${props.resource}`, payload)

      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
        return
      }
      toast.success(editingId ? 'Updated' : 'Created')
      setDialogOpen(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const res = await apiDelete<{ archived?: boolean }>(`/api/admin/${props.resource}/${String(deleteTarget.id)}`)
    if (isApiError(res)) {
      toast.error(res.error.message, { description: res.error.fix })
      return
    }
    toast.success(res?.archived ? 'Archived (was active)' : 'Deleted')
    setDeleteTarget(null)
    load()
  }

  if (auth.status === 'loading') {
    return (
      <DashboardShell title={props.title} subtitle={props.subtitle}>
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </DashboardShell>
    )
  }

  if (auth.status !== 'authenticated') return null

  return (
    <DashboardShell title={props.title} subtitle={props.subtitle}>
      <div className="space-y-4">
        {props.description && (
          <p className="text-sm text-muted-foreground max-w-3xl">{props.description}</p>
        )}

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${props.title.toLowerCase()}...`}
              className="pl-9"
              aria-label={`Search ${props.title}`}
            />
          </div>
          <Button variant="outline" size="sm" onClick={load} aria-label="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Badge variant="secondary" className="text-[11px]">{filtered.length} objects</Badge>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1.5" /> New
            </Button>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {props.columns.map((c) => (
                    <TableHead key={c.key}>{c.label}</TableHead>
                  ))}
                  <TableHead className="text-right w-[130px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={props.columns.length + 1} className="py-16 text-center">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={props.columns.length + 1} className="py-16 text-center text-sm text-muted-foreground">
                      {props.emptyMessage ?? `No ${props.title.toLowerCase()} yet — create the first one.`}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((item) => (
                    <TableRow key={String(item.id)}>
                      {props.columns.map((c) => (
                        <TableCell key={c.key} className="max-w-[320px]">
                          {c.render ? c.render(item) : (
                            <span className="text-sm truncate block">
                              {item[c.key] === null || item[c.key] === undefined ? '—' : String(item[c.key])}
                            </span>
                          )}
                        </TableCell>
                      ))}
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(item)} aria-label="Edit">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => duplicate(item)} aria-label="Duplicate">
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setDeleteTarget(item)} aria-label="Delete">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? `Edit ${props.title.replace(/s$/, '')}` : `New ${props.title.replace(/s$/, '')}`}</DialogTitle>
            <DialogDescription>
              Configuration validated server-side against the schema registry before persistence.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
            {props.fields.map((f) => (
              <div key={f.name} className={cn('space-y-1.5', (f.width ?? 'half') === 'full' && 'sm:col-span-2')}>
                <Label htmlFor={`field-${f.name}`} className="text-xs font-medium">
                  {f.label}
                  {f.required && <span className="text-destructive ml-0.5">*</span>}
                </Label>
                {f.type === 'text' && (
                  <Input
                    id={`field-${f.name}`}
                    value={String(form[f.name] ?? '')}
                    onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                    placeholder={f.placeholder}
                  />
                )}
                {f.type === 'number' && (
                  <Input
                    id={`field-${f.name}`}
                    type="number"
                    value={form[f.name] === undefined ? '' : String(form[f.name])}
                    onChange={(e) => setForm({ ...form, [f.name]: e.target.value === '' ? undefined : Number(e.target.value) })}
                    placeholder={f.placeholder}
                  />
                )}
                {f.type === 'textarea' && (
                  <Textarea
                    id={`field-${f.name}`}
                    value={String(form[f.name] ?? '')}
                    onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                    placeholder={f.placeholder}
                    rows={3}
                  />
                )}
                {f.type === 'json' && (
                  <Textarea
                    id={`field-${f.name}`}
                    value={typeof form[f.name] === 'string' ? String(form[f.name]) : JSON.stringify(form[f.name] ?? (f.defaultValue ?? ''), null, 2)}
                    onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                    placeholder={f.placeholder}
                    rows={6}
                    className="font-mono text-xs"
                  />
                )}
                {f.type === 'select' && (
                  <Select value={String(form[f.name] ?? '')} onValueChange={(v) => setForm({ ...form, [f.name]: v })}>
                    <SelectTrigger id={`field-${f.name}`}>
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      {(f.options ?? []).map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {f.type === 'boolean' && (
                  <div className="flex items-center gap-2 pt-1.5">
                    <Switch
                      id={`field-${f.name}`}
                      checked={Boolean(form[f.name])}
                      onCheckedChange={(v) => setForm({ ...form, [f.name]: v })}
                    />
                    <span className="text-xs text-muted-foreground">{form[f.name] ? 'Yes' : 'No'}</span>
                  </div>
                )}
                {f.type === 'date' && (
                  <Input
                    id={`field-${f.name}`}
                    type="datetime-local"
                    value={form[f.name] ? new Date(String(form[f.name])).toISOString().slice(0, 16) : ''}
                    onChange={(e) => setForm({ ...form, [f.name]: e.target.value ? new Date(e.target.value).toISOString() : null })}
                  />
                )}
                {f.hint && <p className="text-[11px] text-muted-foreground">{f.hint}</p>}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {editingId ? 'Save changes' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive or delete this object?</AlertDialogTitle>
            <AlertDialogDescription>
              Active objects are archived (lifecycle-safe). Drafts and paused objects are permanently deleted.
              Every action is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardShell>
  )
}

// Shared render helpers
export function mono(value: unknown): ReactNode {
  return <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{String(value ?? '—')}</code>
}

export function jsonPreview(raw: unknown, lines = 3): ReactNode {
  const parsed = typeof raw === 'string' ? tryParseJson(raw, raw) : raw
  const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)
  const displayed = text.split('\n').slice(0, lines).join('\n')
  return (
    <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap max-w-[320px] truncate">
      {displayed}
    </pre>
  )
}

export { formatRelative }
