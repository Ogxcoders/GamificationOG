'use client'

/**
 * GamificationOG — Visual Rule Editor (Section 13, §51).
 * Structured WHEN / IF / THEN editing with:
 * - condition tree builder (nested and/or/not groups, 17 operators)
 * - action list builder (registry-driven, typed param inputs, formulas)
 * - per-section Visual ⇄ JSON toggle for power users (lossless round-trip)
 * Server-side validation remains the source of truth on save.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Plus, Trash2, Loader2, ChevronUp, ChevronDown, Braces, Eye, GitBranch,
  Zap, ArrowRight, Code2,
} from 'lucide-react'
import { apiPost, apiPatch, isApiError } from '@/lib/client-api'
import {
  ACTION_CATALOG, ACTION_BY_TYPE, OPERATORS, FIELD_SUGGESTIONS, coerceValue,
  parseListValue, valueToInput, operatorNeedsValue, operatorTakesList,
  operatorTakesTwoValues, operatorLabel, NO_VALUE_OPERATORS,
} from '@/lib/rule-catalog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RuleMetaEvent { name: string; version: number; description: string; source: 'schema' | 'catalog' }
export interface RuleMetaAction { type: string; domain: string; description: string }
export interface RuleMeta {
  eventTypes: RuleMetaEvent[]
  operators: string[]
  fields: string[]
  actions: RuleMetaAction[]
}

export interface RuleRecord {
  id: string
  name: string
  description?: string | null
  eventType: string
  conditionsJson: string
  actionsJson: string
  priority: number
  cooldownSeconds?: number | null
  frequencyCap?: number | null
  frequencyPeriod?: string | null
  status: string
  validFrom?: string | null
  validTo?: string | null
}

interface VisualRuleEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: RuleRecord | null
  meta: RuleMeta
  onSaved: () => void
}

// ---------------------------------------------------------------------------
// Condition tree model
// ---------------------------------------------------------------------------

interface LeafNode { id: string; field: string; operator: string; value: string; value2: string }
interface GroupNode { id: string; op: 'and' | 'or' | 'not'; children: TreeNode[] }
type TreeNode = { kind: 'leaf'; leaf: LeafNode } | { kind: 'group'; group: GroupNode }

const uid = () => Math.random().toString(36).slice(2, 10)

function scalarToInput(value: unknown): string | null {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
    return value.map((v) => (v === null ? '' : String(v))).join(', ')
  }
  return null // object / nested — not representable in visual mode
}

function parseConditionNode(node: unknown): TreeNode | null {
  if (node === null || node === undefined || typeof node !== 'object') return null
  const n = node as Record<string, unknown>
  // logical group
  if (typeof n.op === 'string' && ['and', 'or', 'not'].includes(n.op) && Array.isArray(n.conditions)) {
    const children: TreeNode[] = []
    for (const child of n.conditions) {
      const parsed = parseConditionNode(child)
      if (!parsed) return null
      children.push(parsed)
    }
    return { kind: 'group', group: { id: uid(), op: n.op as GroupNode['op'], children } }
  }
  // field leaf
  if (typeof n.field === 'string' && typeof n.operator === 'string') {
    const value = scalarToInput(n.value)
    const value2 = scalarToInput(n.value2)
    if (value === null || value2 === null) return null
    return {
      kind: 'leaf',
      leaf: { id: uid(), field: n.field, operator: n.operator, value, value2 },
    }
  }
  return null
}

function leafToJson(leaf: LeafNode): Record<string, unknown> {
  const base: Record<string, unknown> = { field: leaf.field.trim(), operator: leaf.operator }
  if (!operatorNeedsValue(leaf.operator)) return base
  if (operatorTakesList(leaf.operator)) {
    base.value = parseListValue(leaf.value)
    return base
  }
  base.value = coerceValue(leaf.value)
  if (operatorTakesTwoValues(leaf.operator)) base.value2 = coerceValue(leaf.value2)
  return base
}

function treeToJson(node: TreeNode): Record<string, unknown> {
  if (node.kind === 'leaf') return leafToJson(node.leaf)
  return { op: node.group.op, conditions: node.group.children.map(treeToJson) }
}

function emptyTree(): TreeNode {
  return { kind: 'group', group: { id: uid(), op: 'and', children: [] } }
}

/** Human summary of a condition tree for the list table. */
export function describeConditions(raw: string): string {
  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>
    const conditions = Array.isArray(parsed.conditions) ? parsed.conditions : []
    if (conditions.length === 0) return 'always'
    const op = typeof parsed.op === 'string' ? parsed.op.toUpperCase() : 'AND'
    return `${op} · ${conditions.length} condition${conditions.length > 1 ? 's' : ''}`
  } catch {
    return '—'
  }
}

/** Human summary of an action list for the list table. */
export function describeActions(raw: string): string {
  try {
    const actions = JSON.parse(raw || '[]') as Array<{ type?: string }>
    if (!Array.isArray(actions) || actions.length === 0) return '—'
    const names = actions.map((a) => a.type ?? '?')
    if (names.length <= 2) return names.join(', ')
    return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`
  } catch {
    return '—'
  }
}

// ---------------------------------------------------------------------------
// Action rows model
// ---------------------------------------------------------------------------

interface ParamRow { key: string; value: string }
interface ActionRow { id: string; type: string; params: ParamRow[] }

function parseActionRow(action: unknown): ActionRow | null {
  if (action === null || typeof action !== 'object') return null
  const a = action as Record<string, unknown>
  if (typeof a.type !== 'string') return null
  const params: ParamRow[] = []
  const raw = a.params ?? {}
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        params.push({ key, value: String(value) })
      } else {
        try {
          params.push({ key, value: JSON.stringify(value) })
        } catch {
          return null
        }
      }
    }
  } else if (raw !== null && raw !== undefined) {
    return null
  }
  return { id: uid(), type: a.type, params }
}

function actionRowToJson(row: ActionRow): Record<string, unknown> {
  const spec = ACTION_BY_TYPE[row.type]
  const params: Record<string, unknown> = {}
  for (const p of row.params) {
    if (p.key.trim() === '') continue
    const value = p.value
    const specParam = spec?.params.find((sp) => sp.key === p.key)
    const kind = specParam?.kind
    if (kind === 'formula' || kind === 'code' || kind === 'text' || kind === 'select') {
      params[p.key] = value
    } else if (kind === 'number') {
      if (value.trim() !== '') {
        const num = Number(value)
        if (Number.isFinite(num)) params[p.key] = num
      }
    } else if (kind === 'json') {
      if (value.trim() !== '') {
        try {
          params[p.key] = JSON.parse(value)
        } catch {
          // invalid JSON — let server validation surface the error
          params[p.key] = value
        }
      }
    } else {
      // 'any' or unknown param — smart coercion
      params[p.key] = coerceValue(value)
    }
  }
  return { type: row.type, params }
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

type SectionMode = 'visual' | 'json'

interface VisualRuleEditorPropsState {
  name: string
  description: string
  eventType: string
  priority: string
  status: string
  cooldownSeconds: string
  frequencyCap: string
  frequencyPeriod: string
  validFrom: string
  validTo: string
}

const EMPTY_FORM: VisualRuleEditorPropsState = {
  name: '', description: '', eventType: '', priority: '100', status: 'active',
  cooldownSeconds: '', frequencyCap: '', frequencyPeriod: 'none', validFrom: '', validTo: '',
}

export function VisualRuleEditor({ open, onOpenChange, initial, meta, onSaved }: VisualRuleEditorProps) {
  const [form, setForm] = useState<VisualRuleEditorPropsState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeNode>(emptyTree())
  const [condMode, setCondMode] = useState<SectionMode>('visual')
  const [condJson, setCondJson] = useState('{"op":"and","conditions":[]}')
  const [rows, setRows] = useState<ActionRow[]>([])
  const [actMode, setActMode] = useState<SectionMode>('visual')
  const [actJson, setActJson] = useState('[]')
  const [saving, setSaving] = useState(false)

  // Load initial values whenever the dialog opens
  useEffect(() => {
    if (!open) return
    if (initial) {
      setEditingId(initial.id)
      setForm({
        name: initial.name ?? '',
        description: initial.description ?? '',
        eventType: initial.eventType ?? '',
        priority: String(initial.priority ?? 100),
        status: initial.status ?? 'active',
        cooldownSeconds: initial.cooldownSeconds == null ? '' : String(initial.cooldownSeconds),
        frequencyCap: initial.frequencyCap == null ? '' : String(initial.frequencyCap),
        frequencyPeriod: initial.frequencyPeriod ?? 'none',
        validFrom: initial.validFrom ? String(initial.validFrom).slice(0, 10) : '',
        validTo: initial.validTo ? String(initial.validTo).slice(0, 10) : '',
      })
      // conditions
      const condText = initial.conditionsJson || '{"op":"and","conditions":[]}'
      let parsedCond: TreeNode | null = null
      try {
        const obj = JSON.parse(condText)
        if (obj && typeof obj === 'object' && Object.keys(obj).length > 0) {
          parsedCond = parseConditionNode(obj)
        } else {
          parsedCond = emptyTree()
        }
      } catch {
        parsedCond = null
      }
      if (parsedCond) {
        setTree(parsedCond)
        setCondMode('visual')
        setCondJson(condText)
      } else {
        setCondJson(condText)
        setCondMode('json')
      }
      // actions
      const actText = initial.actionsJson || '[]'
      let parsedRows: ActionRow[] | null = null
      try {
        const arr = JSON.parse(actText)
        if (Array.isArray(arr)) {
          parsedRows = []
          for (const a of arr) {
            const row = parseActionRow(a)
            if (!row) { parsedRows = null; break }
            parsedRows.push(row)
          }
        }
      } catch {
        parsedRows = null
      }
      if (parsedRows) {
        setRows(parsedRows)
        setActMode('visual')
        setActJson(actText)
      } else {
        setActJson(actText)
        setActMode('json')
      }
    } else {
      setEditingId(null)
      setForm(EMPTY_FORM)
      setTree(emptyTree())
      setCondMode('visual')
      setCondJson('{"op":"and","conditions":[]}')
      setRows([])
      setActMode('visual')
      setActJson('[]')
    }
  }, [open, initial])

  // Keep JSON texts in sync while editing visually
  const syncJsonFromVisual = useCallback(() => {
    if (condMode === 'visual') setCondJson(JSON.stringify(treeToJson(tree), null, 2))
    if (actMode === 'visual') setActJson(JSON.stringify(rows.map(actionRowToJson), null, 2))
  }, [condMode, actMode, tree, rows])

  const switchCondMode = (mode: SectionMode) => {
    if (mode === 'json' && condMode === 'visual') syncJsonFromVisual()
    if (mode === 'visual' && condMode === 'json') {
      try {
        const obj = JSON.parse(condJson || '{}')
        const parsed = obj && typeof obj === 'object' && Object.keys(obj).length > 0 ? parseConditionNode(obj) : emptyTree()
        if (!parsed) {
          toast.error('This condition JSON uses shapes the visual editor cannot represent', {
            description: 'Objects as values or unknown node forms stay in JSON mode.',
          })
          return
        }
        setTree(parsed)
      } catch {
        toast.error('Invalid JSON — fix it before switching to visual mode')
        return
      }
    }
    setCondMode(mode)
  }

  const switchActMode = (mode: SectionMode) => {
    if (mode === 'json' && actMode === 'visual') syncJsonFromVisual()
    if (mode === 'visual' && actMode === 'json') {
      try {
        const arr = JSON.parse(actJson || '[]')
        if (!Array.isArray(arr)) {
          toast.error('Actions must be a JSON array')
          return
        }
        const parsed: ActionRow[] = []
        for (const a of arr) {
          const row = parseActionRow(a)
          if (!row) {
            toast.error('One of the actions cannot be represented visually', {
              description: 'Actions must be objects with a "type" string and scalar params.',
            })
            return
          }
          parsed.push(row)
        }
        setRows(parsed)
      } catch {
        toast.error('Invalid JSON — fix it before switching to visual mode')
        return
      }
    }
    setActMode(mode)
  }

  const save = async () => {
    // client-side guards (server validates authoritatively)
    if (!form.name.trim()) { toast.error('Name is required'); return }
    if (!form.eventType.trim()) { toast.error('WHEN event type is required'); return }
    if (actMode === 'visual' && rows.length === 0) {
      toast.error('At least one THEN action is required')
      return
    }

    let conditionsJson: string
    if (condMode === 'visual') conditionsJson = JSON.stringify(treeToJson(tree))
    else {
      try {
        const parsed = JSON.parse(condJson)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
        conditionsJson = JSON.stringify(parsed)
      } catch {
        toast.error('IF conditions: invalid JSON (must be a condition object)')
        return
      }
    }

    let actionsJson: string
    if (actMode === 'visual') actionsJson = JSON.stringify(rows.map(actionRowToJson))
    else {
      try {
        const parsed = JSON.parse(actJson)
        if (!Array.isArray(parsed)) throw new Error('not an array')
        actionsJson = JSON.stringify(parsed)
      } catch {
        toast.error('THEN actions: invalid JSON (must be an array)')
        return
      }
    }

    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      eventType: form.eventType.trim(),
      conditionsJson,
      actionsJson,
      priority: Number(form.priority) || 100,
      status: form.status,
    }
    if (form.cooldownSeconds.trim() !== '') payload.cooldownSeconds = Number(form.cooldownSeconds)
    if (form.frequencyCap.trim() !== '') payload.frequencyCap = Number(form.frequencyCap)
    if (form.frequencyPeriod !== 'none') payload.frequencyPeriod = form.frequencyPeriod
    if (form.validFrom) payload.validFrom = new Date(form.validFrom).toISOString()
    if (form.validTo) payload.validTo = new Date(form.validTo).toISOString()

    setSaving(true)
    try {
      const res = editingId
        ? await apiPatch(`/api/admin/rules/${editingId}`, payload)
        : await apiPost('/api/admin/rules', payload)
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
        return
      }
      toast.success(editingId ? 'Rule updated' : 'Rule created', { description: 'Validated and persisted — visible in decision traces on the next event.' })
      onOpenChange(false)
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const eventNames = useMemo(() => meta.eventTypes.map((e) => e.name), [meta.eventTypes])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            {editingId ? 'Edit rule' : 'New rule'}
          </DialogTitle>
          <DialogDescription>
            WHEN an event occurs, IF conditions match, THEN execute actions. Validated against the capability registry on save.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {/* ---------- Basics ---------- */}
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Name <span className="text-destructive">*</span></Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Complete task → award XP" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['draft', 'active', 'paused', 'archived'].map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs font-medium">Description</Label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What this automation is for" />
            </div>
          </section>

          {/* ---------- WHEN ---------- */}
          <section className="rounded-lg border bg-muted/30 p-4 space-y-3">
            <header className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-600" />
              <h3 className="text-sm font-semibold tracking-wide">WHEN</h3>
              <span className="text-xs text-muted-foreground">an event of this type occurs</span>
            </header>
            <div className="space-y-1.5">
              <Label htmlFor="rule-event-type" className="text-xs font-medium">Event type <span className="text-destructive">*</span></Label>
              <Input
                id="rule-event-type"
                list="rule-event-types"
                value={form.eventType}
                onChange={(e) => setForm({ ...form, eventType: e.target.value })}
                placeholder="task.completed"
                className="font-mono text-xs"
              />
              <datalist id="rule-event-types">
                {eventNames.map((n) => <option key={n} value={n} />)}
              </datalist>
              <p className="text-[11px] text-muted-foreground">
                Dot-namespaced, lowercase. Suggestions come from your project&apos;s event schemas and the canonical catalog.
              </p>
            </div>
          </section>

          {/* ---------- IF ---------- */}
          <section className="rounded-lg border bg-muted/30 p-4 space-y-3">
            <header className="flex items-center gap-2">
              <Code2 className="h-4 w-4 text-emerald-600" />
              <h3 className="text-sm font-semibold tracking-wide">IF</h3>
              <span className="text-xs text-muted-foreground">conditions match</span>
              <ModeToggle mode={condMode} onChange={switchCondMode} className="ml-auto" />
            </header>
            {condMode === 'visual' ? (
              <ConditionGroupEditor
                node={tree.kind === 'group' ? tree.group : null}
                onChange={(group) => setTree({ kind: 'group', group })}
                isRoot
                fields={meta.fields}
              />
            ) : (
              <Textarea
                value={condJson}
                onChange={(e) => setCondJson(e.target.value)}
                rows={8}
                className="font-mono text-xs"
                aria-label="Conditions JSON"
              />
            )}
          </section>

          {/* ---------- THEN ---------- */}
          <section className="rounded-lg border bg-muted/30 p-4 space-y-3">
            <header className="flex items-center gap-2">
              <ArrowRight className="h-4 w-4 text-rose-600" />
              <h3 className="text-sm font-semibold tracking-wide">THEN</h3>
              <span className="text-xs text-muted-foreground">execute these actions, in order</span>
              <ModeToggle mode={actMode} onChange={switchActMode} className="ml-auto" />
            </header>
            {actMode === 'visual' ? (
              <ActionListEditor rows={rows} onChange={setRows} />
            ) : (
              <Textarea
                value={actJson}
                onChange={(e) => setActJson(e.target.value)}
                rows={8}
                className="font-mono text-xs"
                aria-label="Actions JSON"
              />
            )}
          </section>

          {/* ---------- Advanced ---------- */}
          <details className="rounded-lg border px-4 py-3">
            <summary className="text-xs font-medium cursor-pointer text-muted-foreground">Advanced — priority, guards, schedule</summary>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Priority</Label>
                <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
                <p className="text-[11px] text-muted-foreground">Higher runs first (0–10000)</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Cooldown (seconds)</Label>
                <Input type="number" value={form.cooldownSeconds} onChange={(e) => setForm({ ...form, cooldownSeconds: e.target.value })} placeholder="none" />
                <p className="text-[11px] text-muted-foreground">Minimum time between fires, per user</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Frequency cap</Label>
                <Input type="number" value={form.frequencyCap} onChange={(e) => setForm({ ...form, frequencyCap: e.target.value })} placeholder="none" />
                <p className="text-[11px] text-muted-foreground">Max fires per period, per user</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Frequency period</Label>
                <Select value={form.frequencyPeriod} onValueChange={(v) => setForm({ ...form, frequencyPeriod: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">—</SelectItem>
                    {['hour', 'day', 'week', 'month'].map((p) => (
                      <SelectItem key={p} value={p}>Per {p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Valid from</Label>
                <Input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Valid to</Label>
                <Input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
              </div>
            </div>
          </details>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {editingId ? 'Save changes' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Mode toggle
// ---------------------------------------------------------------------------

function ModeToggle({ mode, onChange, className }: { mode: SectionMode; onChange: (m: SectionMode) => void; className?: string }) {
  return (
    <div className={cn('inline-flex items-center rounded-md border p-0.5 gap-0.5 bg-background', className)} role="tablist" aria-label="Editor mode">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'visual'}
        onClick={() => onChange('visual')}
        className={cn(
          'inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
          mode === 'visual' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Eye className="h-3 w-3" /> Visual
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'json'}
        onClick={() => onChange('json')}
        className={cn(
          'inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
          mode === 'json' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Braces className="h-3 w-3" /> JSON
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Condition group editor (recursive)
// ---------------------------------------------------------------------------

interface GroupEditorProps {
  node: GroupNode
  onChange: (group: GroupNode) => void
  isRoot?: boolean
  depth?: number
  fields: string[]
  onRemove?: () => void
}

function ConditionGroupEditor({ node, onChange, isRoot = false, depth = 0, fields, onRemove }: GroupEditorProps) {
  const updateChild = (index: number, next: TreeNode) => {
    const children = node.children.map((c, i) => (i === index ? next : c))
    onChange({ ...node, children })
  }
  const removeChild = (index: number) => {
    onChange({ ...node, children: node.children.filter((_, i) => i !== index) })
  }
  const addChild = () => {
    onChange({
      ...node,
      children: [...node.children, { kind: 'leaf', leaf: { id: uid(), field: 'event.payload.', operator: 'eq', value: '', value2: '' } }],
    })
  }
  const addGroup = () => {
    onChange({
      ...node,
      children: [...node.children, { kind: 'group', group: { id: uid(), op: 'and', children: [] } }],
    })
  }

  return (
    <div className={cn('rounded-lg border bg-background space-y-2 p-3', isRoot && 'border-dashed')}>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={node.op} onValueChange={(v) => onChange({ ...node, op: v as GroupNode['op'] })}>
          <SelectTrigger className="h-7 w-[76px] text-[11px] font-semibold uppercase" aria-label="Group operator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="and">AND</SelectItem>
            <SelectItem value="or">OR</SelectItem>
            <SelectItem value="not">NOT</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-[11px] text-muted-foreground">
          {node.op === 'not' ? 'none of the children may match' : `${node.children.length} child${node.children.length === 1 ? '' : 'ren'} — all shown must ${node.op}`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={addChild}>
            <Plus className="h-3 w-3 mr-1" /> Condition
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={addGroup}>
            <Plus className="h-3 w-3 mr-1" /> Group
          </Button>
          {!isRoot && onRemove && (
            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={onRemove} aria-label="Remove group">
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {node.children.length === 0 && (
        <p className="text-[11px] text-muted-foreground italic px-1 py-2">
          Empty group — matches everything (rule fires for every event of this type).
        </p>
      )}

      <div className={cn('space-y-2', depth < 6 && node.children.length > 0 && 'border-l-2 border-muted pl-3 ml-1')}>
        {node.children.map((child, index) =>
          child.kind === 'leaf' ? (
            <ConditionLeafEditor
              key={child.leaf.id}
              leaf={child.leaf}
              fields={fields}
              onChange={(leaf) => updateChild(index, { kind: 'leaf', leaf })}
              onRemove={() => removeChild(index)}
            />
          ) : (
            <ConditionGroupEditor
              key={child.group.id}
              node={child.group}
              onChange={(group) => updateChild(index, { kind: 'group', group })}
              depth={depth + 1}
              fields={fields}
              onRemove={() => removeChild(index)}
            />
          ),
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Condition leaf editor
// ---------------------------------------------------------------------------

function ConditionLeafEditor({
  leaf, fields, onChange, onRemove,
}: {
  leaf: LeafNode
  fields: string[]
  onChange: (leaf: LeafNode) => void
  onRemove: () => void
}) {
  const needsValue = operatorNeedsValue(leaf.operator)
  const takesList = operatorTakesList(leaf.operator)
  const takesTwo = operatorTakesTwoValues(leaf.operator)
  return (
    <div className="rounded-lg border bg-background p-2.5 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto] gap-2 items-center">
      <div className="space-y-1">
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">Field</Label>
        <Input
          list="rule-condition-fields"
          value={leaf.field}
          onChange={(e) => onChange({ ...leaf, field: e.target.value })}
          placeholder="event.payload.amount"
          className="font-mono text-xs h-8"
          aria-label="Condition field"
        />
        <datalist id="rule-condition-fields">
          {[...new Set([...fields, ...FIELD_SUGGESTIONS])].map((f) => <option key={f} value={f} />)}
        </datalist>
      </div>
      <div className="space-y-1 sm:w-[150px]">
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">Operator</Label>
        <Select value={leaf.operator} onValueChange={(v) => onChange({ ...leaf, operator: v, value: '', value2: '' })}>
          <SelectTrigger className="h-8 text-xs" aria-label="Operator"><SelectValue /></SelectTrigger>
          <SelectContent className="max-h-72">
            {OPERATORS.map((op) => (
              <SelectItem key={op} value={op} className="text-xs">{operatorLabel(op)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {needsValue ? (
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
            {takesList ? 'Values (comma-sep)' : takesTwo ? 'From' : 'Value'}
          </Label>
          <div className="flex gap-2">
            <Input
              value={leaf.value}
              onChange={(e) => onChange({ ...leaf, value: e.target.value })}
              placeholder={takesList ? 'easy, medium, hard' : takesTwo ? '5' : '10'}
              className={cn('font-mono text-xs h-8', takesTwo && 'w-24')}
              aria-label="Condition value"
            />
            {takesTwo && (
              <Input
                value={leaf.value2}
                onChange={(e) => onChange({ ...leaf, value2: e.target.value })}
                placeholder="50"
                className="font-mono text-xs h-8 w-24"
                aria-label="Condition upper bound"
              />
            )}
          </div>
        </div>
      ) : (
        <div className="hidden sm:block" />
      )}
      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={onRemove} aria-label="Remove condition">
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Action list editor
// ---------------------------------------------------------------------------

function ActionListEditor({ rows, onChange }: { rows: ActionRow[]; onChange: (rows: ActionRow[]) => void }) {
  const updateRow = (index: number, row: ActionRow) => {
    onChange(rows.map((r, i) => (i === index ? row : r)))
  }
  const removeRow = (index: number) => {
    onChange(rows.filter((_, i) => i !== index))
  }
  const moveRow = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= rows.length) return
    const next = [...rows]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 && (
        <p className="text-[11px] text-muted-foreground italic px-1 py-2">
          No actions yet — every rule needs at least one.
        </p>
      )}
      {rows.map((row, index) => (
        <ActionRowEditor
          key={row.id}
          row={row}
          index={index}
          total={rows.length}
          onChange={(next) => updateRow(index, next)}
          onRemove={() => removeRow(index)}
          onMove={(delta) => moveRow(index, delta)}
        />
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...rows, { id: uid(), type: 'award_xp', params: [{ key: 'amount', value: '50' }] }])}>
        <Plus className="h-3.5 w-3.5 mr-1.5" /> Add action
      </Button>
    </div>
  )
}

function ActionRowEditor({
  row, index, total, onChange, onRemove, onMove,
}: {
  row: ActionRow
  index: number
  total: number
  onChange: (row: ActionRow) => void
  onRemove: () => void
  onMove: (delta: number) => void
}) {
  const spec = ACTION_BY_TYPE[row.type]
  const catalogKeys = new Set(spec?.params.map((p) => p.key) ?? [])
  const extraParams = row.params.filter((p) => !catalogKeys.has(p.key))

  const setParam = (key: string, value: string) => {
    const existing = row.params.find((p) => p.key === key)
    if (existing) {
      onChange({ ...row, params: row.params.map((p) => (p.key === key ? { ...p, value } : p)) })
    } else {
      onChange({ ...row, params: [...row.params, { key, value }] })
    }
  }
  const getParam = (key: string): string => row.params.find((p) => p.key === key)?.value ?? ''

  const changeType = (type: string) => {
    // keep params that also exist in the new spec, drop the rest
    const nextSpec = ACTION_BY_TYPE[type]
    const keep = nextSpec ? row.params.filter((p) => nextSpec.params.some((sp) => sp.key === p.key)) : []
    onChange({ ...row, type, params: keep })
  }

  const updateExtraParam = (i: number, key: string, value: string) => {
    const extras = extraParams.map((p, idx) => (idx === i ? { key, value } : p))
    onChange({ ...row, params: [...row.params.filter((p) => catalogKeys.has(p.key)), ...extras] })
  }
  const removeExtraParam = (i: number) => {
    const extras = extraParams.filter((_, idx) => idx !== i)
    onChange({ ...row, params: [...row.params.filter((p) => catalogKeys.has(p.key)), ...extras] })
  }

  return (
    <div className="rounded-lg border bg-background p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-muted text-[11px] font-semibold text-muted-foreground" aria-label={`Action ${index + 1}`}>
          {index + 1}
        </span>
        <Select value={row.type} onValueChange={changeType}>
          <SelectTrigger className="h-8 w-[220px] text-xs font-mono" aria-label="Action type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {Array.from(new Set(ACTION_CATALOG.map((a) => a.domain))).map((domain) => (
              <div key={domain}>
                <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{domain}</p>
                {ACTION_CATALOG.filter((a) => a.domain === domain).map((a) => (
                  <SelectItem key={a.type} value={a.type} className="text-xs font-mono">
                    {a.type}
                  </SelectItem>
                ))}
              </div>
            ))}
            {!spec && <SelectItem value={row.type} className="text-xs font-mono">{row.type}</SelectItem>}
          </SelectContent>
        </Select>
        <span className="text-[11px] text-muted-foreground truncate hidden md:inline max-w-[220px]">
          {spec?.description ?? 'Custom action type — server will validate on save'}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-7 w-7" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" disabled={index === total - 1} onClick={() => onMove(1)} aria-label="Move down">
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={onRemove} aria-label="Remove action">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
        </div>
      </div>

      {/* Catalog params */}
      {spec && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {spec.params.map((p) => (
            <div key={p.key} className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {p.label} {p.required && <span className="text-destructive">*</span>}
              </Label>
              {p.kind === 'select' ? (
                <Select value={getParam(p.key) || p.options?.[0]?.value || ''} onValueChange={(v) => setParam(p.key, v)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {p.options?.map((o) => (
                      <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : p.kind === 'json' ? (
                <Textarea
                  value={getParam(p.key)}
                  onChange={(e) => setParam(p.key, e.target.value)}
                  placeholder={p.placeholder}
                  className="font-mono text-xs min-h-[52px]"
                  aria-label={p.label}
                />
              ) : (
                <Input
                  type={p.kind === 'number' ? 'number' : 'text'}
                  value={getParam(p.key)}
                  onChange={(e) => setParam(p.key, e.target.value)}
                  placeholder={p.placeholder}
                  className={cn('h-8 text-xs', (p.kind === 'formula' || p.kind === 'code') && 'font-mono')}
                  aria-label={p.label}
                />
              )}
              {p.hint && <p className="text-[10px] text-muted-foreground">{p.hint}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Raw JSON for unknown action types */}
      {!spec && (
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Params (JSON)</Label>
          <Textarea
            value={JSON.stringify(Object.fromEntries(row.params.map((p) => [p.key, coerceValue(p.value)])), null, 2)}
            onChange={(e) => {
              try {
                const parsed = JSON.parse(e.target.value || '{}')
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  onChange({ ...row, params: Object.entries(parsed).map(([key, value]) => ({ key, value: valueToInput(value) })) })
                }
              } catch {
                // ignore transient invalid JSON while typing
              }
            }}
            rows={4}
            className="font-mono text-xs"
            aria-label="Action params JSON"
          />
          <p className="text-[10px] text-muted-foreground">Server validation will reject unknown action types on save.</p>
        </div>
      )}

      {/* Extra params beyond the catalog — preserved for round-trip fidelity */}
      {spec && extraParams.length > 0 && (
        <div className="space-y-2 border-t pt-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Additional params</p>
          {extraParams.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={p.key}
                onChange={(e) => updateExtraParam(i, e.target.value, p.value)}
                className="h-7 font-mono text-xs w-40"
                aria-label="Param key"
              />
              <Input
                value={p.value}
                onChange={(e) => updateExtraParam(i, p.key, e.target.value)}
                className="h-7 font-mono text-xs flex-1"
                aria-label="Param value"
              />
              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => removeExtraParam(i)} aria-label="Remove param">
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


