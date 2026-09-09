'use client'

/**
 * Economy page (Section 27) — currencies CRUD + ledger + wallet supply + integrity.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, Coins, ShieldCheck, HardDrive, ArrowDownUp } from 'lucide-react'
import { apiGet, apiPost, isApiError, formatRelative, tryParseJson } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { ResourceCrud, StatusBadge, mono } from '@/components/dashboard/resource-crud'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/sonner-bridge'
import { cn } from '@/lib/utils'

interface LedgerEntry {
  id: string
  user: string | null
  currency: string
  amount: number
  type: string
  source: string
  reason: string | null
  balanceAfter: number
  createdAt: string
}

interface EconomyData {
  totalSupply: Array<{ code: string; supply: number; holders: number }>
  ledger: LedgerEntry[]
}

function CurrenciesCrud() {
  return (
    <ResourceCrud
      resource="currencies"
      title="Currencies"
      subtitle="Soft, hard and premium virtual currencies"
      fields={[
        { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'coins', width: 'half' },
        { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Coins', width: 'half' },
        { name: 'type', label: 'Type', type: 'select', defaultValue: 'soft', options: [
          { value: 'soft', label: 'Soft (earnable)' },
          { value: 'hard', label: 'Hard (premium)' },
          { value: 'premium', label: 'Premium' },
        ], width: 'half' },
        { name: 'exchangeRate', label: 'Exchange rate', type: 'number', defaultValue: 1, hint: 'Rate to soft currency', width: 'half' },
        { name: 'initialBalance', label: 'Initial balance', type: 'number', defaultValue: 0, width: 'half' },
        { name: 'capConfigJson', label: 'Cap config (JSON)', type: 'json', width: 'full', defaultValue: '{}', hint: '{"maxBalance": 100000, "dailyEarnCap": 5000}' },
        { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
          { value: 'draft', label: 'Draft' },
          { value: 'active', label: 'Active' },
          { value: 'paused', label: 'Paused' },
        ], width: 'half' },
      ]}
      columns={[
        { key: 'name', label: 'Currency', render: (item) => (
          <div className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-amber-600" />
            <div>
              <p className="text-sm font-medium">{String(item.name)}</p>
              <p className="text-[11px] text-muted-foreground">{String(item.code)}</p>
            </div>
          </div>
        )},
        { key: 'type', label: 'Type', render: (item) => <StatusBadge status={String(item.type)} /> },
        { key: 'exchangeRate', label: 'Rate', render: (item) => <span className="text-sm tabular-nums">×{String(item.exchangeRate)}</span> },
        { key: 'capConfigJson', label: 'Caps', render: (item) => mono(JSON.stringify(tryParseJson(String(item.capConfigJson ?? ''), {}))) },
        { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
      ]}
    />
  )
}

export default function EconomyPage() {
  const auth = useAuthGuard()
  const [data, setData] = useState<EconomyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [integrity, setIntegrity] = useState<Array<{ currency: string; ledgerSum: number; projectionSum: number; consistent: boolean }> | null>(null)
  const [tab, setTab] = useState('overview')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiGet<EconomyData>('/api/admin/economy/ledger')
      setData(res)
    } catch {
      toast.error('Failed to load economy data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status, load])

  const verify = async () => {
    const res = await apiPost<{ currencies: Array<{ currency: string; ledgerSum: number; projectionSum: number; consistent: boolean }> }>('/api/admin/economy/ledger', { action: 'verify' })
    if (isApiError(res)) {
      toast.error(res.error.message)
      return
    }
    setIntegrity(res.currencies)
    const allOk = res.currencies.every((c) => c.consistent)
    toast[allOk ? 'success' : 'error'](allOk ? 'Ledger and projections are consistent' : 'Integrity mismatch detected!', {
      description: 'Economy accounting: sum(ledger) == sum(projections)',
    })
  }

  const rebuild = async () => {
    const res = await apiPost<{ rebuilt: number }>('/api/admin/economy/ledger', { action: 'rebuild' })
    if (isApiError(res)) {
      toast.error(res.error.message)
      return
    }
    toast.success(`Rebuilt ${res.rebuilt} wallet projections from the ledger`)
    load()
  }

  if (auth.status === 'loading') {
    return (
      <DashboardShell title="Economy" subtitle="Ledger-first virtual economies">
        <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      </DashboardShell>
    )
  }
  if (auth.status !== 'authenticated') return null

  if (tab === 'currencies') return <CurrenciesCrud />

  return (
    <DashboardShell
      title="Economy"
      subtitle="Ledger-first: every mutation is an immutable ledger entry; balances are projections"
    >
      <div className="space-y-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview">Overview & Ledger</TabsTrigger>
            <TabsTrigger value="currencies">Currencies</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {(data?.totalSupply ?? []).map((s) => (
            <Card key={s.code}>
              <CardContent className="p-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{s.code} supply</p>
                <p className="text-2xl font-bold tabular-nums mt-1">{s.supply.toLocaleString()}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{s.holders} holders</p>
              </CardContent>
            </Card>
          ))}
          {(data?.totalSupply ?? []).length === 0 && !loading && (
            <Card className="col-span-full"><CardContent className="py-8 text-center text-sm text-muted-foreground">
              No currencies yet — create one in the Currencies tab.
            </CardContent></Card>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={verify}>
            <ShieldCheck className="h-4 w-4 mr-1.5" /> Verify integrity
          </Button>
          <Button variant="outline" size="sm" onClick={rebuild}>
            <HardDrive className="h-4 w-4 mr-1.5" /> Rebuild projections
          </Button>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>

        {integrity && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Integrity check — sum(ledger) vs sum(projections)</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {integrity.map((c) => (
                <div key={c.currency} className={cn('rounded-lg border px-3 py-2 text-sm', c.consistent ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5')}>
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{c.currency}</span>
                    <Badge variant="outline" className={c.consistent ? 'text-[10px] bg-emerald-500/10 text-emerald-600' : 'text-[10px] bg-red-500/10 text-red-600'}>
                      {c.consistent ? 'consistent' : 'MISMATCH'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 tabular-nums">ledger {c.ledgerSum.toLocaleString()} · projection {c.projectionSum.toLocaleString()}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowDownUp className="h-4 w-4 text-primary" /> Ledger (immutable)
            </CardTitle>
            <CardDescription>
              Every balance-changing transaction with source, reason, correlation and balance-after
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Balance after</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto" /></TableCell></TableRow>
                ) : (data?.ledger ?? []).length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">No transactions yet</TableCell></TableRow>
                ) : (
                  (data?.ledger ?? []).map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="text-sm max-w-[140px] truncate">{t.user ?? '—'}</TableCell>
                      <TableCell><code className="text-xs font-mono">{t.currency}</code></TableCell>
                      <TableCell>
                        <span className={cn('text-sm font-semibold tabular-nums', t.amount > 0 ? 'text-emerald-600' : 'text-red-600')}>
                          {t.amount > 0 ? '+' : ''}{t.amount.toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{t.type}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{t.source}</TableCell>
                      <TableCell className="text-sm tabular-nums">{t.balanceAfter.toLocaleString()}</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground whitespace-nowrap">{formatRelative(t.createdAt)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  )
}
