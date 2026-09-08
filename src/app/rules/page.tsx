'use client'

/**
 * Rules page — WHEN event / IF conditions / THEN actions (Section 13).
 */
import { ResourceCrud, StatusBadge, mono, jsonPreview } from '@/components/dashboard/resource-crud'

const OPERATOR_HINT = 'Operators: and/or/not, eq/ne/gt/lt/gte/lte/in/not_in/contains/starts_with/between/exists...'

export default function RulesPage() {
  return (
    <ResourceCrud
      resource="rules"
      title="Rules"
      subtitle="WHEN an event occurs, IF conditions match, THEN execute actions"
      description="Rules are declarative automations evaluated by the engine in priority order. Every evaluation is recorded in a decision trace with full before/after state. Conditions and actions are validated against the capability registry before saving."
      fields={[
        { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Complete task → award XP', width: 'half' },
        { name: 'eventType', label: 'WHEN event type', type: 'text', required: true, placeholder: 'task.completed', hint: 'dot-namespaced, e.g. task.completed', width: 'half' },
        { name: 'description', label: 'Description', type: 'textarea', width: 'full' },
        { name: 'priority', label: 'Priority', type: 'number', defaultValue: 100, hint: 'Higher runs first (0-10000)', width: 'half' },
        { name: 'status', label: 'Status', type: 'select', options: [
          { value: 'draft', label: 'Draft' },
          { value: 'active', label: 'Active' },
          { value: 'paused', label: 'Paused' },
          { value: 'archived', label: 'Archived' },
        ], defaultValue: 'active', width: 'half' },
        { name: 'conditionsJson', label: 'IF — conditions (JSON)', type: 'json', width: 'full', defaultValue: '{"op":"and","conditions":[]}', hint: `Condition tree. ${OPERATOR_HINT}. Fields: event.payload.*, user.level, user.currency.*, time.hour_of_day...` },
        { name: 'actionsJson', label: 'THEN — actions (JSON array)', type: 'json', width: 'full', required: true, defaultValue: '[{"type":"award_xp","params":{"amount":50}}]', hint: 'Actions: award_xp, add_currency, spend_currency, grant_item, grant_reward, unlock_achievement, update_leaderboard, send_notification, set_user_attribute, set_user_variable, emit_event. Amounts accept formulas like "10 * user.level".' },
        { name: 'cooldownSeconds', label: 'Cooldown (seconds)', type: 'number', placeholder: 'none', hint: 'Minimum time between rule fires', width: 'half' },
        { name: 'frequencyCap', label: 'Frequency cap', type: 'number', placeholder: 'none', hint: 'Max fires per period', width: 'half' },
        { name: 'frequencyPeriod', label: 'Frequency period', type: 'select', options: [
          { value: 'none', label: '—' },
          { value: 'hour', label: 'Per hour' },
          { value: 'day', label: 'Per day' },
          { value: 'week', label: 'Per week' },
          { value: 'month', label: 'Per month' },
        ], width: 'half' },
        { name: 'validFrom', label: 'Valid from', type: 'date', width: 'half' },
        { name: 'validTo', label: 'Valid to', type: 'date', width: 'half' },
      ]}
      columns={[
        { key: 'name', label: 'Name', render: (item) => (
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{String(item.name)}</p>
            <p className="text-[11px] text-muted-foreground truncate">{String(item.description ?? '')}</p>
          </div>
        )},
        { key: 'eventType', label: 'WHEN', render: (item) => mono(item.eventType) },
        { key: 'priority', label: 'Priority', render: (item) => <span className="text-sm tabular-nums">{String(item.priority)}</span> },
        { key: 'conditionsJson', label: 'IF', render: (item) => jsonPreview(item.conditionsJson, 2) },
        { key: 'actionsJson', label: 'THEN', render: (item) => jsonPreview(item.actionsJson, 2) },
        { key: 'status', label: 'Status', render: (item) => <StatusBadge status={String(item.status)} /> },
      ]}
    />
  )
}
