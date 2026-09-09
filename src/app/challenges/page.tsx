'use client'

/**
 * Challenges page (Section 21).
 */
import { ResourceCrud, StatusBadge, mono, jsonPreview } from '@/components/dashboard/resource-crud'

export default function ChallengesPage() {
  return (
    <ResourceCrud
      resource="challenges"
      title="Challenges"
      subtitle="Generic containers for measurable objectives"
      description="A challenge binds an event stream to a target: event counts, payload sums, or unique entities. Daily/weekly/monthly types reset per period via the Time Engine. Completion triggers the configured reward actions."
      fields={[
        { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Complete 5 tasks today', width: 'half' },
        { name: 'type', label: 'Type', type: 'select', required: true, defaultValue: 'daily', options: [
          { value: 'daily', label: 'Daily (resets each day)' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'monthly', label: 'Monthly' },
          { value: 'one_time', label: 'One-time' },
          { value: 'timed', label: 'Timed (fixed window)' },
          { value: 'seasonal', label: 'Seasonal' },
        ], width: 'half' },
        { name: 'description', label: 'Description', type: 'textarea', width: 'full' },
        { name: 'eventType', label: 'Progress event type', type: 'text', required: true, placeholder: 'task.completed', width: 'half' },
        { name: 'metricSource', label: 'Progress source', type: 'select', defaultValue: 'event_count', options: [
          { value: 'event_count', label: 'Event count' },
          { value: 'event_sum', label: 'Payload property sum' },
          { value: 'unique_entities', label: 'Unique entities (subject dedupe)' },
        ], width: 'half' },
        { name: 'payloadProperty', label: 'Payload property', type: 'text', placeholder: 'count (for event_sum)', width: 'half' },
        { name: 'target', label: 'Target', type: 'number', required: true, defaultValue: 5, width: 'half' },
        { name: 'repeatability', label: 'Repeatability', type: 'select', defaultValue: 'repeatable', options: [
          { value: 'repeatable', label: 'Repeatable each period' },
          { value: 'one_time', label: 'One time only' },
        ], width: 'half' },
        { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
          { value: 'draft', label: 'Draft' },
          { value: 'active', label: 'Active' },
          { value: 'paused', label: 'Paused' },
        ], width: 'half' },
        { name: 'startsAt', label: 'Starts at', type: 'date', width: 'half' },
        { name: 'endsAt', label: 'Ends at', type: 'date', width: 'half' },
        { name: 'rewardsJson', label: 'Completion rewards (JSON array)', type: 'json', width: 'full', defaultValue: '[]', hint: 'Actions executed when the challenge completes, e.g. [{"type":"add_currency","params":{"currency":"coins","amount":50}}]' },
      ]}
      columns={[
        { key: 'name', label: 'Challenge', render: (item) => (
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{String(item.name)}</p>
            <p className="text-[11px] text-muted-foreground truncate">{String(item.description ?? '')}</p>
          </div>
        )},
        { key: 'type', label: 'Type', render: (item) => <StatusBadge status={String(item.type)} /> },
        { key: 'eventType', label: 'Event', render: (item) => mono(item.eventType) },
        { key: 'target', label: 'Target', render: (item) => <span className="text-sm tabular-nums">{String(item.target)}</span> },
        { key: 'rewardsJson', label: 'Rewards', render: (item) => jsonPreview(item.rewardsJson, 2) },
        { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
      ]}
    />
  )
}
