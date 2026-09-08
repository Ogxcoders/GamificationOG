'use client'

/**
 * Segments page (Section 33) — dynamic queries over the context.
 */
import { ResourceCrud, StatusBadge, jsonPreview } from '@/components/dashboard/resource-crud'

export default function SegmentsPage() {
  return (
    <ResourceCrud
      resource="segments"
      title="Segments"
      subtitle="Dynamic user cohorts reusable by rules, challenges, paywalls and experiments"
      description="Segments are condition trees evaluated against the live engine context (user attributes, progression, economy state, behavior). An empty condition tree matches everyone — useful as a catch-all. Reference segments by name in rule targeting."
      fields={[
        { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'High earners', width: 'half' },
        { name: 'type', label: 'Type', type: 'select', defaultValue: 'dynamic', options: [
          { value: 'dynamic', label: 'Dynamic (evaluated live)' },
          { value: 'static', label: 'Static (manual membership)' },
        ], width: 'half' },
        { name: 'description', label: 'Description', type: 'textarea', width: 'full' },
        { name: 'conditionsJson', label: 'Conditions (JSON)', type: 'json', width: 'full', defaultValue: '{"op":"and","conditions":[]}', hint: 'Evaluated against live context. Fields: user.level, user.xp, user.currency.coins, user.attribute.plan, user.anonymous... Empty tree = everyone.' },
        { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
          { value: 'draft', label: 'Draft' },
          { value: 'active', label: 'Active' },
          { value: 'paused', label: 'Paused' },
        ], width: 'half' },
      ]}
      columns={[
        { key: 'name', label: 'Segment', render: (item) => (
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{String(item.name)}</p>
            <p className="text-[11px] text-muted-foreground truncate">{String(item.description ?? '')}</p>
          </div>
        )},
        { key: 'type', label: 'Type', render: (item) => <StatusBadge status={String(item.type)} /> },
        { key: 'conditionsJson', label: 'Definition', render: (item) => jsonPreview(item.conditionsJson, 2) },
        { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
      ]}
    />
  )
}
