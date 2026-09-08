'use client'

/**
 * Inventory page (Section 28).
 */
import { ResourceCrud, StatusBadge, mono } from '@/components/dashboard/resource-crud'

export default function InventoryPage() {
  return (
    <ResourceCrud
      resource="items"
      title="Inventory"
      subtitle="Items, consumables, cosmetics — same engine for games and non-games"
      description="Generic inventory items granted by rewards and rules. Stack rules, expiration and equip state are tracked per user. Non-stackable items (e.g. unique cosmetics) reject duplicate grants."
      fields={[
        { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'focus_booster', width: 'half' },
        { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Focus Booster', width: 'half' },
        { name: 'type', label: 'Type', type: 'select', defaultValue: 'consumable', options: [
          { value: 'consumable', label: 'Consumable' },
          { value: 'durable', label: 'Durable' },
          { value: 'cosmetic', label: 'Cosmetic' },
          { value: 'bundle', label: 'Bundle' },
          { value: 'virtual_good', label: 'Virtual good' },
        ], width: 'half' },
        { name: 'stackable', label: 'Stackable', type: 'boolean', defaultValue: true, width: 'half' },
        { name: 'maxStack', label: 'Max stack', type: 'number', defaultValue: 999, width: 'half' },
        { name: 'icon', label: 'Icon (emoji)', type: 'text', placeholder: '⚡', width: 'half' },
        { name: 'description', label: 'Description', type: 'textarea', width: 'full' },
        { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
          { value: 'draft', label: 'Draft' },
          { value: 'active', label: 'Active' },
          { value: 'paused', label: 'Paused' },
        ], width: 'half' },
      ]}
      columns={[
        { key: 'name', label: 'Item', render: (item) => (
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-lg shrink-0">{String(item.icon ?? '📦')}</span>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{String(item.name)}</p>
              <p className="text-[11px] text-muted-foreground truncate">{String(item.description ?? '')}</p>
            </div>
          </div>
        )},
        { key: 'code', label: 'Code', render: (item) => mono(item.code) },
        { key: 'type', label: 'Type', render: (item) => <StatusBadge status={String(item.type)} /> },
        { key: 'stackable', label: 'Stack', render: (item) => (
          <span className="text-sm">{item.stackable ? `stack ×${String(item.maxStack)}` : 'unique'}</span>
        )},
        { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
      ]}
    />
  )
}
