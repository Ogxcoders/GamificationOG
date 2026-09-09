'use client'

/**
 * Achievements page (Section 23).
 */
import { ResourceCrud, StatusBadge, mono, jsonPreview } from '@/components/dashboard/resource-crud'

export default function AchievementsPage() {
  return (
    <ResourceCrud
      resource="achievements"
      title="Achievements"
      subtitle="Unlockable recognition — one-time, repeatable, hidden, progressive"
      description="Achievement conditions are evaluated against the full engine context after every event. Use progressField/progressTarget for progressive achievements (e.g. reach level 10), or plain condition trees for instant unlocks."
      fields={[
        { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'first_task', width: 'half' },
        { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'First Steps', width: 'half' },
        { name: 'category', label: 'Category', type: 'text', defaultValue: 'general', width: 'half' },
        { name: 'type', label: 'Type', type: 'select', defaultValue: 'one_time', options: [
          { value: 'one_time', label: 'One-time' },
          { value: 'repeatable', label: 'Repeatable' },
          { value: 'hidden', label: 'Hidden / secret' },
          { value: 'progressive', label: 'Progressive' },
          { value: 'compound', label: 'Compound' },
        ], width: 'half' },
        { name: 'description', label: 'Description', type: 'textarea', width: 'full' },
        { name: 'points', label: 'Points', type: 'number', defaultValue: 0, width: 'half' },
        { name: 'icon', label: 'Icon (emoji)', type: 'text', placeholder: '🏆', width: 'half' },
        { name: 'hidden', label: 'Hidden until unlocked', type: 'boolean', width: 'half' },
        { name: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [
          { value: 'draft', label: 'Draft' },
          { value: 'active', label: 'Active' },
          { value: 'paused', label: 'Paused' },
        ], width: 'half' },
        { name: 'conditionsJson', label: 'Unlock conditions (JSON)', type: 'json', width: 'full', defaultValue: '{"op":"and","conditions":[]}', hint: 'Plain tree, or progressive: {"progressField":"user.level","progressTarget":10}. Fields: user.level, user.xp, user.currency.coins, user.item.*, event.payload.*' },
        { name: 'rewardsJson', label: 'Unlock rewards (JSON array)', type: 'json', width: 'full', defaultValue: '[]', hint: 'Actions executed on unlock' },
      ]}
      columns={[
        { key: 'name', label: 'Achievement', render: (item) => (
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-lg shrink-0">{String(item.icon ?? '🏅')}</span>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{String(item.name)}</p>
              <p className="text-[11px] text-muted-foreground truncate">{String(item.description ?? '')}</p>
            </div>
          </div>
        )},
        { key: 'code', label: 'Code', render: (item) => mono(item.code) },
        { key: 'type', label: 'Type', render: (item) => <StatusBadge status={String(item.type)} /> },
        { key: 'conditionsJson', label: 'Conditions', render: (item) => jsonPreview(item.conditionsJson, 2) },
        { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
      ]}
    />
  )
}
