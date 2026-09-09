'use client'

/**
 * Streaks page (Section 24) — cadence is configuration, not code.
 */
import { ResourceCrud, StatusBadge, mono, jsonPreview } from '@/components/dashboard/resource-crud'

export default function StreaksPage() {
  return (
    <ResourceCrud
      resource="streaks"
      title="Streaks"
      subtitle="Consistency systems driven by the Time Engine"
      description="A streak definition binds a qualifying event to a cadence (daily/weekly/custom). The Time Engine handles period boundaries, grace periods, breaks, and freeze counts — no hardcoded daily logic. Milestones fire reward actions at exact counts; multipliers scale rewards by streak length."
      fields={[
        { name: 'key', label: 'Key', type: 'text', required: true, placeholder: 'daily', width: 'half' },
        { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Daily Focus Streak', width: 'half' },
        { name: 'cadence', label: 'Cadence', type: 'select', defaultValue: 'daily', options: [
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'custom', label: 'Custom' },
        ], width: 'half' },
        { name: 'eventType', label: 'Qualifying event type', type: 'text', required: true, placeholder: 'streak.checkin', width: 'half' },
        { name: 'gracePeriodHours', label: 'Grace period (hours)', type: 'number', defaultValue: 0, hint: 'Late check-ins still continue the streak', width: 'half' },
        { name: 'freezeCount', label: 'Freezes allowed', type: 'number', defaultValue: 0, hint: 'Streak freezes per period', width: 'half' },
        { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
          { value: 'active', label: 'Active' },
          { value: 'paused', label: 'Paused' },
        ], width: 'half' },
        { name: 'milestonesJson', label: 'Milestones (JSON)', type: 'json', width: 'full', defaultValue: '[]', hint: '[{"at":7,"label":"Week Warrior","rewardsJson":"[{\"type\":\"grant_reward\",\"params\":{\"reward\":\"streak_chest\"}}]"}]' },
        { name: 'rewardMultiplierJson', label: 'Reward multipliers (JSON)', type: 'json', width: 'full', defaultValue: '{}', hint: '{"7": 1.5} = 1.5x rewards at streak 7+' },
      ]}
      columns={[
        { key: 'name', label: 'Streak', render: (item) => (
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{String(item.name)}</p>
            <p className="text-[11px] text-muted-foreground truncate">{String(item.key)}</p>
          </div>
        )},
        { key: 'cadence', label: 'Cadence', render: (item) => <StatusBadge status={String(item.cadence)} /> },
        { key: 'eventType', label: 'Event', render: (item) => mono(item.eventType) },
        { key: 'milestonesJson', label: 'Milestones', render: (item) => jsonPreview(item.milestonesJson, 2) },
        { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
      ]}
    />
  )
}
