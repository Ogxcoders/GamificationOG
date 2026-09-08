'use client'

/**
 * Monetization page (Sections 37-45) — the fourth vertical slice UI:
 * Products / Offers / Paywalls / Personalization + live subscription,
 * entitlement and checkout views with reconciliation controls.
 */
import { useEffect, useState, useCallback } from 'react'
import { Loader2, RefreshCw, CreditCard, ShieldCheck, Receipt } from 'lucide-react'
import { apiGet, apiPost, isApiError, formatRelative, tryParseJson } from '@/lib/client-api'
import { useAuthGuard } from '@/hooks/use-auth-guard'
import { DashboardShell } from '@/components/dashboard/shell'
import { ResourceCrud, StatusBadge } from '@/components/dashboard/resource-crud'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/sonner-bridge'

interface Subscription { id: string; user: string; product: string; productCode: string; tier: string | null; status: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean; price: Record<string, unknown>; provider: string }
interface Entitlement { id: string; user: string; code: string; source: string; status: string; endsAt: string | null }
interface Checkout { id: string; user: string; productCode: string; offerCode: string | null; status: string; price: Record<string, unknown>; createdAt: string; completedAt: string | null }
interface Summary { activeSubscriptions: number; activeEntitlements: number; completedCheckouts: number; revenueEstimate: number }

export default function MonetizationPage() {
  const auth = useAuthGuard()
  const [subs, setSubs] = useState<Subscription[]>([])
  const [ents, setEnts] = useState<Entitlement[]>([])
  const [checkouts, setCheckouts] = useState<Checkout[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [reconciling, setReconciling] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiGet<{ subscriptions: Subscription[]; entitlements: Entitlement[]; recentCheckouts: Checkout[]; summary: Summary }>('/api/admin/monetization')
      setSubs(res.subscriptions)
      setEnts(res.entitlements)
      setCheckouts(res.recentCheckouts)
      setSummary(res.summary)
    } catch {
      toast.error('Failed to load monetization data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (auth.status === 'authenticated') load()
  }, [auth.status, load])

  const reconcile = async () => {
    setReconciling(true)
    const res = await apiPost<{ ok: boolean; result: { expiredSubscriptions: number; activeSubscriptions: number; granted: number; expiredEntitlements: number } }>('/api/admin/monetization', { action: 'reconcile' })
    setReconciling(false)
    if (isApiError(res)) {
      toast.error(res.error.message)
    } else {
      toast.success(`Reconciled: ${res.result.granted} granted, ${res.result.expiredSubscriptions} subs expired, ${res.result.expiredEntitlements} entitlements expired`)
      load()
    }
  }

  const cancelSub = async (user: string, productCode: string) => {
    const res = await apiPost('/api/admin/monetization', { action: 'cancel_subscription', user, product_code: productCode })
    if (isApiError(res)) toast.error(res.error.message)
    else {
      toast.success(`Subscription ${productCode} for ${user} set to cancel at period end`)
      load()
    }
  }

  return (
    <DashboardShell
      title="Monetization"
      subtitle="Products, offers, paywalls, subscriptions & entitlements"
      description="The monetization vertical: offer → paywall → checkout → subscription → entitlement. Providers are abstracted (bundled simulated provider completes the loop). Entitlements reconcile from their sources."
    >
      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="offers">Offers</TabsTrigger>
          <TabsTrigger value="paywalls">Paywalls</TabsTrigger>
          <TabsTrigger value="personalization">Personalization</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><CreditCard className="h-4 w-4 text-primary" /> Active Subscriptions</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold">{summary?.activeSubscriptions ?? '—'}</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4 text-primary" /> Active Entitlements</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold">{summary?.activeEntitlements ?? '—'}</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Receipt className="h-4 w-4 text-primary" /> Completed Checkouts</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold">{summary?.completedCheckouts ?? '—'}</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Revenue Estimate</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold">${(summary?.revenueEstimate ?? 0).toFixed(2)}</p></CardContent>
            </Card>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={reconcile} disabled={reconciling}>
              {reconciling ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Reconcile entitlements
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><CreditCard className="h-4 w-4" /> Subscriptions</CardTitle>
              <CardDescription>Recurring purchase state (provider: simulated)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {subs.length === 0 && <p className="text-sm text-muted-foreground">No subscriptions yet — complete a checkout from the API or SDK.</p>}
              {subs.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
                  <span className="font-medium text-sm">{s.user}</span>
                  <span className="text-sm text-muted-foreground">{s.product}</span>
                  {s.tier && <Badge variant="outline">{s.tier}</Badge>}
                  <StatusBadge status={s.status} />
                  {s.cancelAtPeriodEnd && <Badge variant="destructive">cancels at period end</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">ends {formatRelative(s.currentPeriodEnd)}</span>
                  {['active', 'trialing'].includes(s.status) && !s.cancelAtPeriodEnd && (
                    <Button variant="ghost" size="sm" onClick={() => cancelSub(s.user, s.productCode)}>Cancel</Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Entitlements</CardTitle>
              <CardDescription>Access rights reconciled from subscriptions, purchases, rewards and grants</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {ents.length === 0 && <p className="text-sm text-muted-foreground">No entitlements yet.</p>}
              {ents.map((e) => (
                <div key={e.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
                  <span className="font-medium text-sm">{e.user}</span>
                  <Badge>{e.code}</Badge>
                  <span className="text-xs text-muted-foreground">via {e.source}</span>
                  <StatusBadge status={e.status} />
                  <span className="ml-auto text-xs text-muted-foreground">{e.endsAt ? `expires ${formatRelative(e.endsAt)}` : 'permanent'}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><Receipt className="h-4 w-4" /> Recent Checkouts</CardTitle>
              <CardDescription>Provider-abstracted purchase sessions</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {checkouts.length === 0 && <p className="text-sm text-muted-foreground">No checkout sessions yet.</p>}
              {checkouts.map((c) => {
                const price = (tryParseJson(JSON.stringify(c.price ?? {}), {}) ?? {}) as Record<string, unknown>
                return (
                  <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
                    <span className="font-medium text-sm">{c.user}</span>
                    <span className="text-sm text-muted-foreground">{c.productCode}</span>
                    {c.offerCode && <Badge variant="outline">{c.offerCode}</Badge>}
                    <span className="text-sm">${String(price.amount ?? '?')} {String(price.currency ?? '')}</span>
                    <StatusBadge status={c.status} />
                    <span className="ml-auto text-xs text-muted-foreground">{formatRelative(c.createdAt)}</span>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="products">
          <ResourceCrud
            resource="products"
            title="Products"
            subtitle="Catalog of sellable things"
            description="Product types: subscription (recurring, grants entitlement each period), one_time, consumable (grants virtual currency through the ledger), entitlement (permanent access right). priceTiersJson: [{ tier, amount, currency, trialDays? }]."
            fields={[
              { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'focus_pro', width: 'half' },
              { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'FocusQuest Pro', width: 'half' },
              { name: 'type', label: 'Type', type: 'select', defaultValue: 'subscription', options: [
                { value: 'subscription', label: 'Subscription (recurring)' },
                { value: 'one_time', label: 'One-time purchase' },
                { value: 'consumable', label: 'Consumable (currency grant)' },
                { value: 'entitlement', label: 'Entitlement (permanent access)' },
              ], width: 'half' },
              { name: 'entitlementCode', label: 'Entitlement code', type: 'text', placeholder: 'pro', width: 'half', hint: 'Access right granted on purchase' },
              { name: 'description', label: 'Description', type: 'textarea', width: 'full' },
              { name: 'priceTiersJson', label: 'Price tiers (JSON)', type: 'json', width: 'full', defaultValue: '[{"tier":"monthly","amount":9.99,"currency":"usd","trialDays":7}]' },
              { name: 'metadataJson', label: 'Metadata (JSON)', type: 'json', width: 'full', defaultValue: '{}', hint: 'Consumables: { "currency": "coins", "amount": 500 }' },
              { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
                { value: 'draft', label: 'Draft' },
                { value: 'active', label: 'Active' },
                { value: 'paused', label: 'Paused' },
              ], width: 'half' },
            ]}
            columns={[
              { key: 'name', label: 'Product', render: (item) => (
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{String(item.name)}</p>
                  <p className="text-[11px] text-muted-foreground">{String(item.code)}</p>
                </div>
              )},
              { key: 'type', label: 'Type', render: (item) => <StatusBadge status={String(item.type)} /> },
              { key: 'priceTiersJson', label: 'Tiers', render: (item) => (
                <div className="text-xs text-muted-foreground">
                  {(tryParseJson(String(item.priceTiersJson ?? '[]'), []) as Array<{ tier: string; amount: number; currency: string }>).map((t) => (
                    <span key={t.tier} className="mr-2">{t.tier}: ${t.amount} {t.currency}</span>
                  ))}
                </div>
              )},
              { key: 'entitlementCode', label: 'Entitlement', render: (item) => item.entitlementCode ? <Badge>{String(item.entitlementCode)}</Badge> : <span className="text-xs text-muted-foreground">—</span> },
              { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
            ]}
          />
        </TabsContent>

        <TabsContent value="offers">
          <ResourceCrud
            resource="offers"
            title="Offers"
            subtitle="Targeted pricing and packaging"
            description="Offers override product tier pricing for targeted users. targetingJson is a condition tree (user.attribute.plan, user.level, user.entitlement.*). Highest priority matching offer wins at the paywall."
            fields={[
              { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'pro_launch_40', width: 'half' },
              { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Launch Offer — 40% off', width: 'half' },
              { name: 'productCode', label: 'Product code', type: 'text', required: true, placeholder: 'focus_pro', width: 'half' },
              { name: 'priority', label: 'Priority', type: 'number', defaultValue: 100, width: 'half' },
              { name: 'description', label: 'Description', type: 'textarea', width: 'full' },
              { name: 'pricingJson', label: 'Pricing override (JSON)', type: 'json', width: 'full', defaultValue: '{"tier":"monthly","amount":5.99,"originalAmount":9.99,"label":"40% off"}' },
              { name: 'targetingJson', label: 'Targeting (JSON)', type: 'json', width: 'full', defaultValue: '{"op":"and","conditions":[]}' },
              { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
                { value: 'draft', label: 'Draft' },
                { value: 'active', label: 'Active' },
                { value: 'paused', label: 'Paused' },
              ], width: 'half' },
            ]}
            columns={[
              { key: 'name', label: 'Offer', render: (item) => (
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{String(item.name)}</p>
                  <p className="text-[11px] text-muted-foreground">{String(item.code)} · {String(item.productCode)}</p>
                </div>
              )},
              { key: 'pricingJson', label: 'Pricing', render: (item) => {
                const p = (tryParseJson(String(item.pricingJson ?? '{}'), {}) ?? {}) as Record<string, unknown>
                return <span className="text-xs">${String(p.amount ?? '?')} <span className="line-through text-muted-foreground">{String(p.originalAmount ?? '')}</span> {String(p.label ?? '')}</span>
              }},
              { key: 'targetingJson', label: 'Targeting', render: (item) => (
                <span className="text-[11px] text-muted-foreground truncate block max-w-[220px]">{String(item.targetingJson)}</span>
              )},
              { key: 'priority', label: 'Priority', render: (item) => <Badge variant="outline">{String(item.priority)}</Badge> },
              { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
            ]}
          />
        </TabsContent>

        <TabsContent value="paywalls">
          <ResourceCrud
            resource="paywalls"
            title="Paywalls"
            subtitle="Entitlement-gated walls with presented offers"
            description="A paywall evaluates: is the user missing the entitlement, and does the wall's targeting match? Locked users see the referenced offers (or all targeted offers). configJson carries client rendering hints (title, body, cta)."
            fields={[
              { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'advanced_analytics', width: 'half' },
              { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Advanced Analytics Wall', width: 'half' },
              { name: 'entitlementCode', label: 'Required entitlement', type: 'text', required: true, placeholder: 'pro', width: 'half' },
              { name: 'offersJson', label: 'Offers (JSON array)', type: 'json', width: 'full', defaultValue: '[]', hint: 'Offer codes presented at this wall; empty = all active targeted offers' },
              { name: 'targetingJson', label: 'When the wall applies (JSON)', type: 'json', width: 'full', defaultValue: '{"op":"and","conditions":[]}' },
              { name: 'configJson', label: 'Client hints (JSON)', type: 'json', width: 'full', defaultValue: '{"title":"Unlock Premium","cta":"Try free"}' },
              { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
                { value: 'draft', label: 'Draft' },
                { value: 'active', label: 'Active' },
                { value: 'paused', label: 'Paused' },
              ], width: 'half' },
            ]}
            columns={[
              { key: 'name', label: 'Paywall', render: (item) => (
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{String(item.name)}</p>
                  <p className="text-[11px] text-muted-foreground">{String(item.code)}</p>
                </div>
              )},
              { key: 'entitlementCode', label: 'Gates', render: (item) => <Badge>{String(item.entitlementCode)}</Badge> },
              { key: 'offersJson', label: 'Offers', render: (item) => (
                <span className="text-xs text-muted-foreground">{((tryParseJson(String(item.offersJson ?? '[]'), []) ?? []) as string[]).join(', ') || 'all targeted'}</span>
              )},
              { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
            ]}
          />
        </TabsContent>

        <TabsContent value="personalization">
          <ResourceCrud
            resource="personalization-rules"
            title="Personalization"
            subtitle="Targeted overrides of remote config values"
            description="Evaluation chain: remote config (base) → personalization rules (condition-targeted, highest priority wins) → user variables. Override any remote-config key per segment or attribute."
            fields={[
              { name: 'key', label: 'Config key to override', type: 'text', required: true, placeholder: 'daily_xp_cap', width: 'half' },
              { name: 'priority', label: 'Priority', type: 'number', defaultValue: 100, width: 'half' },
              { name: 'valueJson', label: 'Value (JSON)', type: 'json', required: true, width: 'full', defaultValue: '{"value":8000}' },
              { name: 'targetingJson', label: 'Targeting (JSON)', type: 'json', width: 'full', defaultValue: '{"op":"and","conditions":[]}' },
              { name: 'description', label: 'Description', type: 'textarea', width: 'full' },
              { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
                { value: 'draft', label: 'Draft' },
                { value: 'active', label: 'Active' },
                { value: 'paused', label: 'Paused' },
              ], width: 'half' },
            ]}
            columns={[
              { key: 'key', label: 'Key', render: (item) => <span className="font-mono text-sm">{String(item.key)}</span> },
              { key: 'valueJson', label: 'Value', render: (item) => <span className="text-xs">{String(item.valueJson)}</span> },
              { key: 'targetingJson', label: 'Targeting', render: (item) => (
                <span className="text-[11px] text-muted-foreground truncate block max-w-[220px]">{String(item.targetingJson)}</span>
              )},
              { key: 'priority', label: 'Priority', render: (item) => <Badge variant="outline">{String(item.priority)}</Badge> },
              { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
            ]}
          />
        </TabsContent>
      </Tabs>
    </DashboardShell>
  )
}
