'use client'

/**
 * Rules page — Visual WHEN / IF / THEN rule builder (Section 13, §51).
 * Structured editor with registry-driven dropdowns, condition tree
 * builder, action param forms, and per-section Visual ⇄ JSON toggle.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Pencil, Trash2, Loader2, RefreshCw, Search, Copy, GitBranch } from 'lucide-react'
import { apiGet, apiPost, apiDelete, isApiError } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { StatusBadge } from '@/components/dashboard/resource-crud'
import { VisualRuleEditor, describeConditions, describeActions, type RuleRecord, type RuleMeta } from '@/components/rules/visual-rule-editor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { toast } from '@/sonner-bridge'
import { mono } from '@/components/dashboard/resource-crud'

export default function RulesPage() {
  const auth = useAuthGuard()
  const [items, setItems] = useState<RuleRecord[]>([])
  const [meta, setMeta] = useState<RuleMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<RuleRecord | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RuleRecord | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [data, metaRes] = await Promise.all([
        apiGet<{ items: RuleRecord[] }>('/api/admin/rules'),
        apiGet<RuleMeta>('/api/admin/rules-meta'),
      ])
      setItems(data.items ?? [])
      setMeta(metaRes)
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
  }, [])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status, load])

  const filtered = useMemo(() => {
    if (!query) return items
    const q = query.toLowerCase()
    return items.filter((item) => JSON.stringify(item).toLowerCase().includes(q))
  }, [items, query])

  const duplicate = async (item: RuleRecord) => {
    const res = await apiPost('/api/admin/rules', {
      name: `${item.name} (copy)`,
      description: item.description ?? undefined,
      eventType: item.eventType,
      conditionsJson: item.conditionsJson,
      actionsJson: item.actionsJson,
      priority: item.priority,
      status: 'draft',
      cooldownSeconds: item.cooldownSeconds ?? undefined,
      frequencyCap: item.frequencyCap ?? undefined,
      frequencyPeriod: item.frequencyPeriod ?? undefined,
    })
    if (isApiError(res)) {
      toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
    } else {
      toast.success('Duplicated as draft')
      load()
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const res = await apiDelete<{ archived?: boolean }>(`/api/admin/rules/${deleteTarget.id}`)
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
      <DashboardShell title="Rules" subtitle="WHEN an event occurs, IF conditions match, THEN execute actions">
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </DashboardShell>
    )
  }

  if (auth.status !== 'authenticated') return null

  return (
    <DashboardShell title="Rules" subtitle="WHEN an event occurs, IF conditions match, THEN execute actions">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground max-w-3xl">
          Rules are declarative automations evaluated by the engine in priority order. Build them
          visually or in JSON — every evaluation is recorded in a decision trace with full
          before/after state, and conditions/actions are validated against the capability registry
          before saving.
        </p>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search rules..."
              className="pl-9"
              aria-label="Search rules"
            />
          </div>
          <Button variant="outline" size="sm" onClick={load} aria-label="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Badge variant="secondary" className="text-[11px]">{filtered.length} rules</Badge>
            <Button size="sm" onClick={() => { setEditing(null); setEditorOpen(true) }} disabled={!meta}>
              <Plus className="h-4 w-4 mr-1.5" /> New rule
            </Button>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rule</TableHead>
                  <TableHead>WHEN</TableHead>
                  <TableHead>IF</TableHead>
                  <TableHead>THEN</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right w-[130px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-16 text-center">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-16 text-center text-sm text-muted-foreground">
                      <GitBranch className="h-6 w-6 mx-auto mb-2 opacity-40" />
                      No rules yet — create the first automation with the visual builder.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="max-w-[260px]">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{item.name}</p>
                          <p className="text-[11px] text-muted-foreground truncate">{item.description ?? ''}</p>
                        </div>
                      </TableCell>
                      <TableCell>{mono(item.eventType)}</TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">{describeConditions(item.conditionsJson)}</span>
                      </TableCell>
                      <TableCell>
                        <code className="text-[11px] font-mono text-muted-foreground">{describeActions(item.actionsJson)}</code>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm tabular-nums">{item.priority}</span>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={item.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditing(item); setEditorOpen(true) }} aria-label="Edit in visual builder">
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

      {/* Visual rule builder */}
      {meta && (
        <VisualRuleEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          initial={editing}
          meta={meta}
          onSaved={load}
        />
      )}

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive or delete this rule?</AlertDialogTitle>
            <AlertDialogDescription>
              Active rules are archived (lifecycle-safe). Drafts and paused rules are permanently
              deleted. Every action is recorded in the audit log.
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
