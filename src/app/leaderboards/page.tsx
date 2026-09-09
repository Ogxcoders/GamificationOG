'use client'

/**
 * Leaderboards page (Section 29) — systems, not screens.
 */
import { ResourceCrud, StatusBadge, mono, jsonPreview } from '@/components/dashboard/resource-crud'

export default function LeaderboardsPage() {
  return (
    <ResourceCrud
      resource="leaderboards"
      title="Leaderboards"
      subtitle="Metric + algorithm + window + tie breaker = ranking system"
      description="Leaderboards are ranking systems decoupled from presentation. Metrics come from events, XP, or formulas; windows reset via the Time Engine; dense ranks recompute deterministically with earliest-first tie breaking."
      fields={[
        { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'weekly_xp', width: 'half' },
        { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Weekly XP Leaders', width: 'half' },
        { name: 'metricSource', label: 'Metric source', type: 'select', defaultValue: 'event_sum', options: [
          { value: 'event_count', label: 'Event count' },
          { value: 'event_sum', label: 'Payload property sum' },
          { value: 'xp', label: 'Total XP (synced)' },
        ], width: 'half' },
        { name: 'eventType', label: 'Event type', type: 'text', placeholder: 'task.completed (optional)', width: 'half' },
        { name: 'payloadProperty', label: 'Payload property', type: 'text', placeholder: 'minutes (for event_sum)', width: 'half' },
        { name: 'algorithm', label: 'Algorithm', type: 'select', defaultValue: 'highest', options: [
          { value: 'highest', label: 'Highest score wins' },
          { value: 'lowest', label: 'Lowest score wins' },
        ], width: 'half' },
        { name: 'timeWindow', label: 'Time window', type: 'select', defaultValue: 'all_time', options: [
          { value: 'all_time', label: 'All-time' },
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'monthly', label: 'Monthly' },
          { value: 'seasonal', label: 'Seasonal' },
        ], width: 'half' },
        { name: 'tieBreaker', label: 'Tie breaker', type: 'select', defaultValue: 'earliest', options: [
          { value: 'earliest', label: 'Earliest first' },
          { value: 'latest', label: 'Latest first' },
        ], width: 'half' },
        { name: 'maxEntries', label: 'Max entries', type: 'number', defaultValue: 1000, width: 'half' },
        { name: 'rewardsJson', label: 'Rank rewards (JSON)', type: 'json', width: 'full', defaultValue: '[]', hint: '[{"rankFrom":1,"rankTo":3,"rewardsJson":"[{\"type\":\"grant_reward\",\"params\":{\"reward\":\"gold_trophy\"}}]"}]' },
        { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
          { value: 'draft', label: 'Draft' },
          { value: 'active', label: 'Active' },
          { value: 'paused', label: 'Paused' },
        ], width: 'half' },
      ]}
      columns={[
        { key: 'name', label: 'Leaderboard', render: (item) => (
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{String(item.name)}</p>
            <p className="text-[11px] text-muted-foreground truncate">{String(item.code)}</p>
          </div>
        )},
        { key: 'metricSource', label: 'Metric', render: (item) => <StatusBadge status={String(item.metricSource)} /> },
        { key: 'timeWindow', label: 'Window', render: (item) => mono(item.timeWindow) },
        { key: 'algorithm', label: 'Algorithm', render: (item) => mono(item.algorithm) },
        { key: 'rewardsJson', label: 'Rank rewards', render: (item) => jsonPreview(item.rewardsJson, 1) },
        { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
      ]}
    />
  )
}
