/**
 * GamificationOG — Built-in Pack Catalog (Section 57).
 * Reusable behavior bundles: rules, achievements, streaks, leaderboards.
 * Objects mirror the admin create API field shapes and are validated
 * through the same resource validators on install.
 */

export interface PackRuleDef {
  resource: 'rules'
  name: string
  description?: string
  eventType: string
  conditionsJson?: string
  actionsJson: string
  priority?: number
  cooldownSeconds?: number
  frequencyCap?: number
  frequencyPeriod?: 'hour' | 'day' | 'week' | 'month'
  status?: string
}

export interface PackAchievementDef {
  resource: 'achievements'
  code: string
  name: string
  description?: string
  category?: string
  type?: string
  conditionsJson?: string
  points?: number
  icon?: string
  status?: string
}

export interface PackStreakDef {
  resource: 'streaks'
  key: string
  name: string
  cadence?: 'daily' | 'weekly' | 'custom'
  eventType: string
  gracePeriodHours?: number
  milestonesJson?: string
  rewardMultiplierJson?: string
  status?: string
}

export interface PackLeaderboardDef {
  resource: 'leaderboards'
  code: string
  name: string
  metricSource?: string
  eventType?: string
  payloadProperty?: string
  algorithm?: 'highest' | 'lowest'
  timeWindow?: 'all_time' | 'daily' | 'weekly' | 'monthly' | 'seasonal'
  maxEntries?: number
  status?: string
}

export type PackObjectDef = PackRuleDef | PackAchievementDef | PackStreakDef | PackLeaderboardDef

export interface PackDefinition {
  rules?: PackRuleDef[]
  achievements?: PackAchievementDef[]
  streaks?: PackStreakDef[]
  leaderboards?: PackLeaderboardDef[]
}

export interface BuiltInPack {
  slug: string
  name: string
  description: string
  category: string
  version: string
  definition: PackDefinition
}

const and = (...conditions: Array<Record<string, unknown>>) => JSON.stringify({ op: 'and', conditions })
const action = (type: string, params: Record<string, unknown>) => JSON.stringify([{ type, params }])
const actions = (...acts: Array<{ type: string; params: Record<string, unknown> }>) => JSON.stringify(acts)

export const BUILT_IN_PACKS: BuiltInPack[] = [
  {
    slug: 'daily-streak',
    name: 'Daily Streak',
    description: 'Consistency loop: track daily check-ins, escalate multipliers at milestones, and re-engage users when a streak breaks.',
    category: 'streaks',
    version: '1.0.0',
    definition: {
      streaks: [
        {
          resource: 'streaks',
          key: 'daily_checkin',
          name: 'Daily Check-in Streak',
          cadence: 'daily',
          eventType: 'app.opened',
          gracePeriodHours: 4,
          milestonesJson: JSON.stringify([
            { at: 3, rewardsJson: '[]' },
            { at: 7, rewardsJson: '[]' },
            { at: 30, rewardsJson: '[]' },
          ]),
          rewardMultiplierJson: JSON.stringify({ '7': 1.5, '30': 2 }),
          status: 'active',
        },
      ],
      rules: [
        {
          resource: 'rules',
          name: 'Daily check-in → streak + XP',
          description: 'Mark the streak and grant a small base reward on app open.',
          eventType: 'app.opened',
          actionsJson: actions(
            { type: 'update_streak', params: { streak: 'daily_checkin' } },
            { type: 'award_xp', params: { amount: 5 } },
          ),
          cooldownSeconds: 3600,
          status: 'active',
        },
        {
          resource: 'rules',
          name: 'Streak milestone → celebration',
          description: 'Notify the user when a 7-day milestone is hit.',
          eventType: 'streak.updated',
          conditionsJson: and({ field: 'event.payload.milestone', operator: 'eq', value: 7 }),
          actionsJson: action('send_notification', { title: '7-day streak!', body: 'Keep going — your multiplier just went up.', type: 'success' }),
          status: 'active',
        },
      ],
      achievements: [
        {
          resource: 'achievements',
          code: 'streak_week_warrior',
          name: 'Week Warrior',
          description: 'Checked in 7 days in a row.',
          category: 'consistency',
          points: 50,
          status: 'active',
        },
      ],
    },
  },
  {
    slug: 'productivity-core',
    name: 'Productivity Core',
    description: 'Deep-work rewards: XP proportional to focused minutes, difficulty multipliers, and a deep-focus badge.',
    category: 'productivity',
    version: '1.0.0',
    definition: {
      rules: [
        {
          resource: 'rules',
          name: 'Focus session → XP by minutes',
          description: '2 XP per focused minute, capped at 120 per session.',
          eventType: 'focus.session.completed',
          conditionsJson: and(
            { field: 'event.payload.minutes', operator: 'between', value: 1, value2: 60 },
            { field: 'event.payload.focused', operator: 'eq', value: true },
          ),
          actionsJson: actions(
            { type: 'award_xp', params: { amount: 'min(event.payload.minutes, 60) * 2' } },
            { type: 'update_challenge_progress', params: { challenge: 'deep_work_goal', delta: 1 } },
          ),
          status: 'active',
        },
        {
          resource: 'rules',
          name: 'Hard task → bonus XP',
          description: 'Hard tasks award double XP.',
          eventType: 'task.completed',
          conditionsJson: and({ field: 'event.payload.difficulty', operator: 'eq', value: 'hard' }),
          actionsJson: action('award_xp', { amount: 40 }),
          status: 'active',
        },
      ],
      achievements: [
        {
          resource: 'achievements',
          code: 'deep_focus_master',
          name: 'Deep Focus Master',
          description: 'Completed 50 focus sessions.',
          category: 'productivity',
          points: 100,
          status: 'active',
        },
      ],
    },
  },
  {
    slug: 'learning-loop',
    name: 'Learning Loop',
    description: 'Skill-building loop: XP per lesson, quiz bonuses for correctness, and progressive mastery badges.',
    category: 'learning',
    version: '1.0.0',
    definition: {
      rules: [
        {
          resource: 'rules',
          name: 'Lesson completed → XP',
          description: 'Base XP for finishing any lesson.',
          eventType: 'lesson.completed',
          actionsJson: action('award_xp', { amount: 15 }),
          status: 'active',
        },
        {
          resource: 'rules',
          name: 'Perfect quiz → bonus',
          description: 'Full-correct quizzes grant bonus XP.',
          eventType: 'quiz.completed',
          conditionsJson: and({ field: 'event.payload.correct', operator: 'eq', value: 'all' }),
          actionsJson: actions(
            { type: 'award_xp', params: { amount: 25 } },
            { type: 'emit_event', params: { type: 'learning.perfect_quiz', payload: {} } },
          ),
          status: 'active',
        },
      ],
      achievements: [
        {
          resource: 'achievements',
          code: 'knowledge_seeker',
          name: 'Knowledge Seeker',
          description: 'Completed 10 lessons.',
          category: 'learning',
          points: 40,
          status: 'active',
        },
        {
          resource: 'achievements',
          code: 'quiz_ace',
          name: 'Quiz Ace',
          description: 'Aced 5 quizzes with full marks.',
          category: 'learning',
          points: 60,
          status: 'active',
        },
      ],
    },
  },
  {
    slug: 'community-champion',
    name: 'Community Champion',
    description: 'Rewards helpful behavior: XP for answers and posts, with escalating champion badges.',
    category: 'community',
    version: '1.0.0',
    definition: {
      rules: [
        {
          resource: 'rules',
          name: 'Helpful answer → XP',
          description: 'Posting an accepted answer grants XP.',
          eventType: 'answer.accepted',
          actionsJson: action('award_xp', { amount: 20 }),
          frequencyCap: 10,
          frequencyPeriod: 'day',
          status: 'active',
        },
        {
          resource: 'rules',
          name: 'First post → welcome XP',
          description: 'Small reward for breaking the ice.',
          eventType: 'post.created',
          conditionsJson: and({ field: 'event.payload.isFirst', operator: 'eq', value: true }),
          actionsJson: action('award_xp', { amount: 10 }),
          status: 'active',
        },
      ],
      achievements: [
        {
          resource: 'achievements',
          code: 'community_builder',
          name: 'Community Builder',
          description: 'Contributed 25 helpful answers.',
          category: 'community',
          points: 80,
          status: 'active',
        },
      ],
    },
  },
  {
    slug: 'referral-engine',
    name: 'Referral Engine',
    description: 'Two-sided referral rewards: both referrer and new user get XP when the invite converts.',
    category: 'referral',
    version: '1.0.0',
    definition: {
      rules: [
        {
          resource: 'rules',
          name: 'Referral converted → reward both',
          description: 'When a referred user activates, reward the referrer and notify the pair.',
          eventType: 'user.referred.converted',
          actionsJson: actions(
            { type: 'award_xp', params: { amount: 100 } },
            { type: 'send_notification', params: { title: 'Referral successful', body: 'Your invite joined — bonus XP awarded!', type: 'success' } },
          ),
          status: 'active',
        },
      ],
      achievements: [
        {
          resource: 'achievements',
          code: 'connector',
          name: 'The Connector',
          description: 'Successfully referred 5 users.',
          category: 'referral',
          points: 120,
          status: 'active',
        },
      ],
    },
  },
  {
    slug: 'weekly-competition',
    name: 'Weekly Competition',
    description: 'Weekly XP race: a reseting leaderboard plus race announcements to keep players engaged.',
    category: 'competition',
    version: '1.0.0',
    definition: {
      leaderboards: [
        {
          resource: 'leaderboards',
          code: 'weekly_xp_race',
          name: 'Weekly XP Race',
          metricSource: 'xp',
          algorithm: 'highest',
          timeWindow: 'weekly',
          maxEntries: 500,
          status: 'active',
        },
      ],
      rules: [
        {
          resource: 'rules',
          name: 'XP earned → race entry',
          description: 'Mirror every XP award into the weekly race.',
          eventType: 'xp.awarded',
          actionsJson: action('update_leaderboard', { leaderboard: 'weekly_xp_race', score: 'event.payload.amount', mode: 'increment' }),
          status: 'active',
        },
      ],
    },
  },
  {
    slug: 'loyalty-program',
    name: 'Loyalty Program',
    description: 'Reward repeat engagement: XP per purchase milestone plus tiered loyalty badges.',
    category: 'loyalty',
    version: '1.0.0',
    definition: {
      rules: [
        {
          resource: 'rules',
          name: 'Purchase → loyalty XP',
          description: 'XP proportional to order value (1 XP per unit).',
          eventType: 'purchase.completed',
          actionsJson: action('award_xp', { amount: 'event.payload.value' }),
          status: 'active',
        },
        {
          resource: 'rules',
          name: 'Repeat customer → thanks',
          description: 'Thank returning buyers.',
          eventType: 'purchase.completed',
          conditionsJson: and({ field: 'event.payload.orderCount', operator: 'gte', value: 3 }),
          actionsJson: action('send_notification', { title: 'Thanks for being a regular!', body: 'Loyalty XP has been added to your account.', type: 'info' }),
          status: 'active',
        },
      ],
      achievements: [
        {
          resource: 'achievements',
          code: 'loyal_customer',
          name: 'Loyal Customer',
          description: 'Made 5 purchases.',
          category: 'loyalty',
          points: 90,
          status: 'active',
        },
      ],
    },
  },
  {
    slug: 'rpg-core',
    name: 'RPG Core',
    description: 'Role-playing flavor: quest XP, boss-battle bonuses, and an epic tier of achievements.',
    category: 'rpg',
    version: '1.0.0',
    definition: {
      rules: [
        {
          resource: 'rules',
          name: 'Quest completed → XP',
          description: 'Standard quest reward on the rpg track.',
          eventType: 'quest.completed',
          actionsJson: action('award_xp', { amount: 30, track: 'rpg' }),
          status: 'active',
        },
        {
          resource: 'rules',
          name: 'Boss defeated → epic XP',
          description: 'Bosses grant double XP and an announcement event.',
          eventType: 'boss.defeated',
          actionsJson: actions(
            { type: 'award_xp', params: { amount: 60, track: 'rpg' } },
            { type: 'emit_event', params: { type: 'rpg.boss_slain', payload: {} } },
          ),
          status: 'active',
        },
      ],
      achievements: [
        {
          resource: 'achievements',
          code: 'boss_slayer',
          name: 'Boss Slayer',
          description: 'Defeated your first boss.',
          category: 'rpg',
          points: 150,
          status: 'active',
        },
      ],
    },
  },
]

export function getBuiltInPack(slug: string): BuiltInPack | undefined {
  return BUILT_IN_PACKS.find((p) => p.slug === slug)
}

export function packObjectCounts(def: PackDefinition): Record<string, number> {
  return {
    rules: def.rules?.length ?? 0,
    achievements: def.achievements?.length ?? 0,
    streaks: def.streaks?.length ?? 0,
    leaderboards: def.leaderboards?.length ?? 0,
  }
}
