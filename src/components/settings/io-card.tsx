'use client'

/**
 * GamificationOG — Import / Export card (Sections 59-60).
 * Export: download the gamification system as a portable JSON package.
 * Import: upload/paste a package → dry-run diff preview (validation +
 * conflicts) → apply with skip/overwrite strategy.
 */
import { useRef, useState } from 'react'
import { Download, Upload, Loader2, FileJson, AlertTriangle, CheckCircle2, ArrowRight, ArrowDownToLine, Search } from 'lucide-react'
import { apiGet, apiPost, isApiError } from '@/lib/client-api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface ObjectPlan {
  resource: string
  naturalKey: string
  action: 'create' | 'overwrite' | 'skip' | 'identical'
  reason?: string
}

interface ImportPreview {
  mode: string
  strategy: string
  manifest: { project?: string; environment?: string; exportedAt?: string; counts?: Record<string, number> }
  objects: ObjectPlan[]
  summary: { create: number; overwrite: number; skip: number; identical: number }
  warnings: string[]
}

type ApplyResult = ImportPreview & { applied: boolean }

const ACTION_BADGES: Record<string, { label: string; className: string }> = {
  create: { label: 'create', className: 'text-emerald-600 border-emerald-500/30' },
  overwrite: { label: 'overwrite', className: 'text-amber-600 border-amber-500/30' },
  skip: { label: 'skip', className: 'text-zinc-500 border-zinc-500/30' },
  identical: { label: 'identical', className: 'text-zinc-400 border-zinc-400/30' },
}

export function ImportExportCard() {
  const [exporting, setExporting] = useState(false)
  const [pasted, setPasted] = useState('')
  const [pkg, setPkg] = useState<unknown>(null)
  const [packageName, setPackageName] = useState('')
  const [strategy, setStrategy] = useState<'skip' | 'overwrite'>('skip')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const exportPackage = async () => {
    setExporting(true)
    try {
      const data = await apiGet<Record<string, unknown>>('/api/admin/export')
      if (isApiError(data)) {
        toast.error(data.error.message, { description: data.error.fix })
        return
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const manifest = (data as { manifest?: { project?: string; environment?: string } }).manifest
      a.href = url
      a.download = `gamification-${(manifest?.project ?? 'system').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${manifest?.environment ?? 'env'}-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      const counts = (data as { manifest?: { counts?: Record<string, number> } }).manifest?.counts
      const total = counts ? Object.values(counts).reduce((s, n) => s + n, 0) : 0
      toast.success('Package exported', { description: `${total} objects across ${counts ? Object.keys(counts).length : 0} resource kinds.` })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  const loadFile = async (file: File) => {
    const text = await file.text()
    setPackageName(file.name)
    setPasted(text.slice(0, 400))
    try {
      const parsed = JSON.parse(text)
      setPkg(parsed)
      setPreview(null)
      toast.success('Package loaded', { description: `${file.name} parsed — run a dry-run to preview the diff.` })
    } catch {
      setPkg(null)
      toast.error('Invalid JSON file')
    }
  }

  const runDryRun = async () => {
    if (!pkg) {
      toast.error('Load or paste a package first')
      return
    }
    setPreviewing(true)
    try {
      const res = await apiPost<{ preview: ImportPreview }>('/api/admin/import', { package: pkg, mode: 'dry-run', strategy })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
        return
      }
      setPreview(res.preview)
    } finally {
      setPreviewing(false)
    }
  }

  const apply = async () => {
    if (!pkg) return
    setApplying(true)
    try {
      const res = await apiPost<{ result: ApplyResult }>('/api/admin/import', { package: pkg, mode: 'apply', strategy })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix ?? res.error.detail })
        return
      }
      const s = res.result.summary
      toast.success('Import applied', {
        description: `${s.create} created · ${s.overwrite} overwritten · ${s.skip} skipped · ${s.identical} identical — audited and transactional.`,
      })
      setPreview(res.result)
    } finally {
      setApplying(false)
    }
  }

  const pasteAsPackage = () => {
    try {
      const parsed = JSON.parse(pasted)
      setPkg(parsed)
      setPackageName('pasted package')
      setPreview(null)
      toast.success('Package parsed from text')
    } catch {
      toast.error('Pasted text is not valid JSON')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><FileJson className="h-4 w-4 text-primary" /> Import / Export</CardTitle>
        <CardDescription>
          Portable gamification system packages (§59) — manifest + rules, achievements, streaks, currencies, items,
          leaderboards, segments, challenges, tracks, event schemas. Import runs validation → diff → conflict
          detection before anything is written.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Export */}
        <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <p className="text-sm font-medium flex items-center gap-2"><Download className="h-4 w-4" /> Export current environment</p>
              <p className="text-xs text-muted-foreground">Natural-keyed, id-free — mergeable into any project/environment.</p>
            </div>
            <Button size="sm" onClick={exportPackage} disabled={exporting}>
              {exporting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Download className="h-4 w-4 mr-1.5" />}
              Download package
            </Button>
          </div>
        </div>

        {/* Import */}
        <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
          <p className="text-sm font-medium flex items-center gap-2"><Upload className="h-4 w-4" /> Import a package</p>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) loadFile(f)
                e.target.value = ''
              }}
              aria-label="Package JSON file"
            />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload className="h-3.5 w-3.5 mr-1.5" /> Choose file
            </Button>
            <span className="text-xs text-muted-foreground truncate max-w-[200px]">
              {packageName || 'No package loaded'}
            </span>
            {pkg && (
              <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-500/30">
                <CheckCircle2 className="h-3 w-3 mr-1" /> parsed
              </Badge>
            )}
          </div>

          <Textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="…or paste package JSON here"
            rows={3}
            className="font-mono text-xs"
            aria-label="Package JSON"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={pasteAsPackage} disabled={!pasted.trim()}>
              Parse text
            </Button>
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-muted-foreground">Conflicts:</span>
              <Select value={strategy} onValueChange={(v) => { setStrategy(v as 'skip' | 'overwrite'); setPreview(null) }}>
                <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Conflict strategy"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip" className="text-xs">Skip (safe)</SelectItem>
                  <SelectItem value="overwrite" className="text-xs">Overwrite</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" onClick={runDryRun} disabled={!pkg || previewing}>
                {previewing ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Search className="h-4 w-4 mr-1.5" />}
                Dry-run preview
              </Button>
            </div>
          </div>

          {/* Preview results */}
          {preview && (
            <div className="space-y-3 border-t pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Plan:</span>
                {(['create', 'overwrite', 'skip', 'identical'] as const).map((k) => {
                  const n = preview.summary[k]
                  if (!n) return null
                  return (
                    <Badge key={k} variant="outline" className={cn('text-[10px]', ACTION_BADGES[k].className)}>
                      {n} {k}
                    </Badge>
                  )
                })}
                <span className="text-[11px] text-muted-foreground ml-auto">
                  from {preview.manifest.project ?? '?'} / {preview.manifest.environment ?? '?'} · exported {String(preview.manifest.exportedAt ?? '').slice(0, 10)}
                </span>
              </div>

              {preview.warnings.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 space-y-1">
                  {preview.warnings.slice(0, 4).map((w, i) => (
                    <p key={i} className="text-[11px] text-amber-600 flex items-start gap-1.5">
                      <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {w}
                    </p>
                  ))}
                  {preview.warnings.length > 4 && (
                    <p className="text-[11px] text-amber-600">+{preview.warnings.length - 4} more warnings</p>
                  )}
                </div>
              )}

              <div className="max-h-56 overflow-y-auto rounded-md border divide-y">
                {preview.objects
                  .filter((o) => o.action === 'create' || o.action === 'overwrite' || o.action === 'skip')
                  .slice(0, 60)
                  .map((o, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1.5">
                      <Badge variant="outline" className={cn('text-[10px] shrink-0', ACTION_BADGES[o.action].className)}>
                        {o.action === 'create' ? <ArrowRight className="h-3 w-3 mr-1" /> : o.action === 'overwrite' ? <ArrowDownToLine className="h-3 w-3 mr-1" /> : null}
                        {ACTION_BADGES[o.action].label}
                      </Badge>
                      <span className="text-xs truncate flex-1">
                        <span className="text-muted-foreground">{o.resource}</span> · {o.naturalKey}
                      </span>
                      {o.reason && <span className="text-[10px] text-muted-foreground truncate max-w-[220px] hidden md:inline">{o.reason}</span>}
                    </div>
                  ))}
                {preview.objects.every((o) => o.action === 'identical') && (
                  <p className="px-3 py-3 text-xs text-muted-foreground">Everything in this package is already present with identical content.</p>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <Button size="sm" onClick={apply} disabled={applying || (preview.summary.create + preview.summary.overwrite === 0 && preview.summary.skip === 0)}>
                  {applying ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
                  Apply import ({preview.summary.create + preview.summary.overwrite} changes, {strategy} strategy)
                </Button>
                <p className="text-[11px] text-muted-foreground">Transactional — rolls back entirely on failure. Audited.</p>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
