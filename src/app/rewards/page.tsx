'use client'

/**
 * Rewards page (Section 26) — abstract outcomes.
 */
import { ResourceCrud, StatusBadge, mono, jsonPreview } from '@/components/dashboard/resource-crud'

export default function RewardsPage() {
  return (
    <ResourceCrud
      resource="rewards"
      title="Rewards"
      subtitle="Abstract, composable outcomes granted by rules, challenges, achievements and streaks"
      description="A reward definition resolves to concrete grants through the owning domain engines: progression (xp), economy (currency), inventory (item), or lightweight state (points, badges, entitlements). Granting is idempotent and fully audited."
      fields={[
        { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'coin_chest_small', width: 'half' },
        { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Small Coin Chest', width: 'half' },
        { name: 'type', label: 'Type', type: 'select', required: true, defaultValue: 'currency', options: [
          { value: 'xp', label: 'XP (progression)' },
          { value: 'currency', label: 'Currency (economy)' },
          { value: 'item', label: 'Item (inventory)' },
          { value: 'points', label: 'Points (state)' },
          { value: 'badge', label: 'Badge (state)' },
          { value: 'entitlement', label: 'Entitlement (state)' },
          { value: 'discount', label: 'Discount' },
          { value: 'custom', label: 'Custom (plugin)' },
        ], width: 'half' },
        { name: 'stackRule', label: 'Stack rule', type: 'select', defaultValue: 'allow', options: [
          { value: 'allow', label: 'Allow stacking' },
          { value: 'replace', label: 'Replace' },
          { value: 'reject', label: 'Reject duplicates' },
        ], width: 'half' },
        { name: 'description', label: 'Description', type: 'textarea', width: 'full' },
        { name: 'configJson', label: 'Configuration (JSON)', type: 'json', width: 'full', defaultValue: '{}', required: true, hint: 'By type — xp: {"xpAmount":100,"trackCode":"default"} · currency: {"currencyCode":"coins","amount":50} · item: {"itemCode":"booster","quantity":1} · entitlement: {"entitlementKey":"premium_theme"}' },
        { name: 'expiresAt', label: 'Expires at', type: 'date', width: 'half' },
        { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
          { value: 'draft', label: 'Draft' },
          { value: 'active', label: 'Active' },
          { value: 'paused', label: 'Paused' },
        ], width: 'half' },
      ]}
      columns={[
        { key: 'name', label: 'Reward', render: (item) => (
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{String(item.name)}</p>
            <p className="text-[11px] text-muted-foreground truncate">{String(item.description ?? '')}</p>
          </div>
        )},
        { key: 'code', label: 'Code', render: (item) => mono(item.code) },
        { key: 'type', label: 'Type', render: (item) => <StatusBadge status={String(item.type)} /> },
        { key: 'configJson', label: 'Config', render: (item) => jsonPreview(item.configJson, 2) },
        { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
      ]}
    />
  )
}
