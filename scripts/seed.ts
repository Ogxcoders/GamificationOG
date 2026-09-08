/**
 * GamificationOG — Customer Zero Seed (Section 103/104).
 * Creates a complete reference project ("FocusQuest" — a productivity app)
 * using ONLY platform primitives: schemas, currencies, items, rewards,
 * progression, rules, challenges, achievements, streaks, leaderboards,
 * segments, notifications, flags + demo users and events.
 *
 * Run: bun run seed
 */
import { PrismaClient } from '@prisma/client'
import { createHash, scryptSync, randomBytes } from 'crypto'

const db = new PrismaClient()

function hashPassword(password: string, salt?: string): string {
  const s = salt ?? randomBytes(16).toString('hex')
  const hash = scryptSync(password, s, 64).toString('hex')
  return `${s}:${hash}`
}

async function main() {
  console.log('🌱 Seeding GamificationOG — Customer Zero reference project...\n')

  // ---- Tenancy: Organization > Workspace > Project > Environments ----
  const existingOrg = await db.organization.findFirst({ where: { slug: 'acme' } })
  if (existingOrg) {
    console.log('Organization already exists — skipping seed (use db reset to re-seed).')
    return
  }

  const org = await db.organization.create({ data: { name: 'Acme Inc', slug: 'acme' } })
  const workspace = await db.workspace.create({
    data: { organizationId: org.id, name: 'Product Team', slug: 'product' },
  })
  const project = await db.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'FocusQuest',
      slug: 'focusquest',
      description: 'Customer Zero — a productivity app reference implementation using only platform primitives',
      timezone: 'UTC',
      environments: { create: [
        { name: 'development' }, { name: 'staging' }, { name: 'production' },
      ] },
    },
    include: { environments: true },
  })
  const devEnv = project.environments.find((e) => e.name === 'development')!
  const prodEnv = project.environments.find((e) => e.name === 'production')!
  console.log(`✓ Tenancy: org "${org.name}" > workspace > project "${project.name}" (dev/staging/prod)`)

  const env = devEnv // seed into development

  // ---- Admin owner (dashboard login) ----
  const adminEmail = 'owner@focusquest.app'
  await db.adminUser.create({
    data: {
      email: adminEmail,
      name: 'Platform Owner',
      passwordHash: hashPassword('gamification123'),
      role: 'owner',
    },
  })
  console.log(`✓ Admin owner: ${adminEmail} / gamification123 (change this immediately)`)

  // ---- Event schemas ----
  const schemas = [
    { name: 'user.session.start', description: 'User opened the app', spec: {} },
    { name: 'task.completed', description: 'User completed a task', spec: { count: { type: 'number', required: false, min: 1, max: 20, description: 'Number of tasks completed at once' }, difficulty: { type: 'string', required: false, enum: ['easy', 'medium', 'hard'] }, minutes: { type: 'number', required: false, min: 1, max: 600 } } },
    { name: 'focus.session.completed', description: 'User finished a focus session', spec: { minutes: { type: 'number', required: true, min: 1, max: 480 } } },
    { name: 'goal.created', description: 'User created a goal', spec: {} },
    { name: 'lesson.completed', description: 'User finished a lesson', spec: { category: { type: 'string', required: false } } },
    { name: 'item.purchased', description: 'User purchased an inventory item', spec: { item: { type: 'string', required: true }, price: { type: 'number', required: true, min: 0 } } },
    { name: 'streak.checkin', description: 'Explicit daily check-in', spec: {} },
    { name: 'referral.sent', description: 'User invited a friend', spec: {} },
  ]
  for (const s of schemas) {
    await db.eventSchema.create({
      data: { projectId: project.id, name: s.name, description: s.description, payloadSchemaJson: JSON.stringify(s.spec), status: 'active' },
    })
  }
  console.log(`✓ Event schemas: ${schemas.length}`)

  // ---- Currencies ----
  const currencies = [
    { code: 'xp_points', name: 'XP Points', type: 'soft', exchangeRate: 1, cap: { maxBalance: 1000000 } },
    { code: 'coins', name: 'Coins', type: 'soft', exchangeRate: 1, cap: { maxBalance: 100000, dailyEarnCap: 5000 } },
    { code: 'gems', name: 'Gems', type: 'hard', exchangeRate: 100, cap: { maxBalance: 10000 } },
  ]
  for (const c of currencies) {
    await db.currency.create({
      data: { projectId: project.id, environmentId: env.id, code: c.code, name: c.name, type: c.type, exchangeRate: c.exchangeRate, capConfigJson: JSON.stringify(c.cap) },
    })
  }
  console.log(`✓ Currencies: ${currencies.map((c) => c.code).join(', ')}`)

  // ---- Items ----
  const items = [
    { code: 'focus_booster', name: 'Focus Booster', type: 'consumable', description: '2x XP for 30 minutes', icon: '⚡', maxStack: 99 },
    { code: 'streak_freeze', name: 'Streak Freeze', type: 'consumable', description: 'Protects your streak for one missed day', icon: '🧊', maxStack: 5 },
    { code: 'gold_badge', name: 'Gold Badge', type: 'cosmetic', description: 'Profile flair for top performers', icon: '🥇', maxStack: 1 },
  ]
  for (const i of items) {
    await db.item.create({
      data: { projectId: project.id, environmentId: env.id, code: i.code, name: i.name, type: i.type, description: i.description, icon: i.icon, maxStack: i.maxStack, stackable: i.maxStack > 1 },
    })
  }
  console.log(`✓ Items: ${items.map((i) => i.code).join(', ')}`)

  // ---- Rewards ----
  const rewards = [
    { code: 'daily_chest', name: 'Daily Chest', type: 'currency', config: { currencyCode: 'coins', amount: 100 } },
    { code: 'weekly_bonus', name: 'Weekly Bonus', type: 'currency', config: { currencyCode: 'coins', amount: 500 } },
    { code: 'focus_booster_pack', name: 'Focus Booster Pack', type: 'item', config: { itemCode: 'focus_booster', quantity: 3 } },
    { code: 'streak_chest', name: 'Streak Milestone Chest', type: 'currency', config: { currencyCode: 'coins', amount: 250 } },
    { code: 'vip_trial', name: 'VIP Trial', type: 'entitlement', config: { entitlementKey: 'vip_7d' } },
    { code: 'xp_boost_100', name: '100 XP Boost', type: 'xp', config: { xpAmount: 100, trackCode: 'default' } },
  ]
  for (const r of rewards) {
    await db.reward.create({
      data: { projectId: project.id, environmentId: env.id, code: r.code, name: r.name, type: r.type, configJson: JSON.stringify(r.config), description: `${r.type} reward` },
    })
  }
  console.log(`✓ Rewards: ${rewards.length}`)

  // ---- Progression track ----
  await db.progressionTrack.create({
    data: {
      projectId: project.id, environmentId: env.id, code: 'default',
      name: 'Focus Level', type: 'linear', baseXpPerLevel: 100, growthFactor: 1.0, maxLevel: 50,
    },
  })
  console.log('✓ Progression track: default (linear, 100 XP/level, max 50)')

  // ---- Notification templates ----
  const templates = [
    { key: 'level_up', title: 'Level {{level}} reached! 🎉', body: 'You hit level {{level}}. Keep the momentum going!' },
    { key: 'challenge_complete', title: 'Challenge complete: {{challenge}}', body: 'Nice work — rewards have been granted.' },
    { key: 'streak_milestone', title: '{{streak}}-day streak! 🔥', body: 'Consistency pays. Milestone rewards are yours.' },
    { key: 'achievement_unlock', title: 'Achievement: {{achievement}}', body: 'You unlocked "{{achievement}}". Well earned.' },
  ]
  for (const t of templates) {
    await db.notificationTemplate.create({
      data: { projectId: project.id, key: t.key, name: t.key.replace(/_/g, ' '), channel: 'in_app', titleTemplate: t.title, bodyTemplate: t.body },
    })
  }
  console.log(`✓ Notification templates: ${templates.length}`)

  // ---- Rules (the heart of the demo) ----
  const rules = [
    {
      name: 'Complete task → XP + Coins',
      eventType: 'task.completed',
      description: 'Core loop: every completed task earns XP scaled by difficulty plus base coins',
      priority: 100,
      conditions: { op: 'and', conditions: [] },
      actions: [
        { type: 'award_xp', params: { amount: '20 + (event.payload.difficulty == "hard" ? 30 : event.payload.difficulty == "medium" ? 10 : 0)' } },
        { type: 'add_currency', params: { currency: 'coins', amount: 10 } },
      ],
    },
    {
      name: 'Focus session → XP by minutes',
      eventType: 'focus.session.completed',
      description: 'Deep work is rewarded proportionally: 2 XP per focused minute, capped at 60',
      priority: 90,
      conditions: { op: 'and', conditions: [] },
      actions: [
        { type: 'award_xp', params: { amount: 'min(event.payload.minutes * 2, 60)' } },
      ],
    },
    {
      name: 'Hard task → focus booster drop',
      eventType: 'task.completed',
      description: 'Hard tasks have a 50% chance to drop a focus booster (level-gated)',
      priority: 80,
      conditions: { op: 'and', conditions: [
        { field: 'event.payload.difficulty', operator: 'eq', value: 'hard' },
        { field: 'user.level', operator: 'gte', value: 3 },
      ] },
      actions: [
        { type: 'grant_item', params: { item: 'focus_booster', quantity: 1 } },
      ],
    },
    {
      name: 'Referral sent → gems',
      eventType: 'referral.sent',
      description: 'Grow the community: each successful referral earns a premium gem',
      priority: 70,
      conditions: { op: 'and', conditions: [] },
      actions: [
        { type: 'add_currency', params: { currency: 'gems', amount: 1 } },
        { type: 'send_notification', params: { title: 'Thanks for the referral! 💎', type: 'reward' } },
      ],
    },
    {
      name: 'Night owl bonus',
      eventType: 'focus.session.completed',
      description: 'Evening focus (20:00-23:59 UTC) earns double XP',
      priority: 60,
      conditions: { op: 'or', conditions: [
        { field: 'time.hour_of_day', operator: 'gte', value: 20 },
        { field: 'time.hour_of_day', operator: 'lte', value: 4 },
      ] },
      actions: [
        { type: 'award_xp', params: { amount: 20 } },
      ],
    },
    {
      name: 'Purchaser welcome VIP trial',
      eventType: 'item.purchased',
      description: 'First purchase triggers a VIP entitlement + notification',
      priority: 50,
      conditions: { op: 'and', conditions: [
        { field: 'user.currency.coins', operator: 'lt', value: 200 },
      ] },
      actions: [
        { type: 'grant_reward', params: { reward: 'vip_trial' } },
        { type: 'send_notification', params: { title: 'VIP trial activated 👑', type: 'reward' } },
      ],
    },
  ]
  for (const r of rules) {
    await db.rule.create({
      data: {
        projectId: project.id, environmentId: env.id,
        name: r.name, description: r.description, eventType: r.eventType,
        conditionsJson: JSON.stringify(r.conditions), actionsJson: JSON.stringify(r.actions),
        priority: r.priority, status: 'active',
      },
    })
  }
  console.log(`✓ Rules: ${rules.length}`)

  // ---- Challenges ----
  const challenges = [
    {
      name: 'Complete 5 tasks today', type: 'daily', eventType: 'task.completed', metricSource: 'event_count', target: 5,
      description: 'Daily productivity challenge',
      rewards: [{ type: 'grant_reward', params: { reward: 'daily_chest' } }],
    },
    {
      name: 'Focus 120 minutes this week', type: 'weekly', eventType: 'focus.session.completed', metricSource: 'event_sum', payloadProperty: 'minutes', target: 120,
      description: 'Weekly deep-work challenge',
      rewards: [{ type: 'grant_reward', params: { reward: 'weekly_bonus' } }, { type: 'award_xp', params: { amount: 200 } }],
    },
    {
      name: 'Invite 3 friends', type: 'one_time', eventType: 'referral.sent', metricSource: 'event_count', target: 3,
      description: 'One-time community challenge',
      rewards: [{ type: 'add_currency', params: { currency: 'gems', amount: 5 } }],
    },
    {
      name: 'First 10 lessons (unique)', type: 'one_time', eventType: 'lesson.completed', metricSource: 'unique_entities', target: 10,
      description: 'Complete 10 distinct lessons',
      rewards: [{ type: 'grant_reward', params: { reward: 'xp_boost_100' } }],
    },
  ]
  for (const c of challenges) {
    await db.challenge.create({
      data: {
        projectId: project.id, environmentId: env.id,
        name: c.name, description: c.description, type: c.type,
        eventType: c.eventType, metricSource: c.metricSource,
        payloadProperty: c.payloadProperty ?? null, target: c.target,
        rewardsJson: JSON.stringify(c.rewards), repeatability: c.type === 'daily' || c.type === 'weekly' ? 'repeatable' : 'one_time',
      },
    })
  }
  console.log(`✓ Challenges: ${challenges.length}`)

  // ---- Achievements ----
  const achievements = [
    { code: 'first_task', name: 'First Steps', type: 'one_time', icon: '👣', points: 10, description: 'Complete your first task', conditions: { progressField: 'user.xp', progressTarget: 20 }, rewards: [{ type: 'add_currency', params: { currency: 'coins', amount: 50 } }] },
    { code: 'level_5', name: 'Apprentice', type: 'one_time', icon: '🧭', points: 50, description: 'Reach level 5', conditions: { progressField: 'user.level', progressTarget: 5 }, rewards: [{ type: 'grant_reward', params: { reward: 'focus_booster_pack' } }] },
    { code: 'level_10', name: 'Adept', type: 'one_time', icon: '🗺️', points: 100, description: 'Reach level 10', conditions: { progressField: 'user.level', progressTarget: 10 }, rewards: [{ type: 'grant_reward', params: { reward: 'vip_trial' } }] },
    { code: 'coin_collector', name: 'Coin Collector', type: 'progressive', icon: '💰', points: 25, description: 'Hold 1,000 coins', conditions: { progressField: 'user.currency.coins', progressTarget: 1000 }, rewards: [{ type: 'send_notification', params: { title: 'Coin Collector achievement unlocked! 🪙', type: 'achievement' } }] },
    { code: 'night_owl', name: 'Night Owl', type: 'hidden', icon: '🦉', points: 75, description: 'Focus between 20:00 and 05:00', hidden: true, conditions: { op: 'and', conditions: [
      { field: 'time.hour_of_day', operator: 'gte', value: 20 },
      { field: 'event.type', operator: 'eq', value: 'focus.session.completed' },
    ] }, rewards: [] },
    { code: 'social_butterfly', name: 'Social Butterfly', type: 'one_time', icon: '🦋', points: 40, description: 'Send 5 referrals', conditions: { progressField: 'user.xp', progressTarget: 400 }, rewards: [{ type: 'add_currency', params: { currency: 'gems', amount: 2 } }] },
  ]
  for (const a of achievements) {
    await db.achievement.create({
      data: {
        projectId: project.id, environmentId: env.id,
        code: a.code, name: a.name, description: a.description, type: a.type,
        icon: a.icon, points: a.points, hidden: a.hidden ?? false,
        conditionsJson: JSON.stringify(a.conditions), rewardsJson: JSON.stringify(a.rewards ?? []),
      },
    })
  }
  console.log(`✓ Achievements: ${achievements.length}`)

  // ---- Streaks ----
  const streaks = [
    {
      key: 'daily_focus', name: 'Daily Focus Streak', cadence: 'daily', eventType: 'task.completed',
      gracePeriodHours: 3, freezeCount: 2,
      milestones: [
        { at: 3, label: 'Warming Up' },
        { at: 7, label: 'Week Warrior', rewardsJson: JSON.stringify([{ type: 'grant_reward', params: { reward: 'streak_chest' } }]) },
        { at: 30, label: 'Unstoppable', rewardsJson: JSON.stringify([{ type: 'add_currency', params: { currency: 'gems', amount: 10 } }]) },
      ],
      multipliers: { '7': 1.5, '30': 2 },
    },
  ]
  for (const s of streaks) {
    await db.streak.create({
      data: {
        projectId: project.id, environmentId: env.id,
        key: s.key, name: s.name, cadence: s.cadence, eventType: s.eventType,
        gracePeriodHours: s.gracePeriodHours, freezeCount: s.freezeCount,
        milestonesJson: JSON.stringify(s.milestones), rewardMultiplierJson: JSON.stringify(s.multipliers),
      },
    })
  }
  console.log(`✓ Streaks: ${streaks.length}`)

  // ---- Leaderboards ----
  const leaderboards = [
    { code: 'all_time_xp', name: 'All-Time XP', metricSource: 'xp', timeWindow: 'all_time' },
    { code: 'weekly_focus_minutes', name: 'Weekly Focus Minutes', metricSource: 'event_sum', eventType: 'focus.session.completed', payloadProperty: 'minutes', timeWindow: 'weekly' },
    { code: 'daily_tasks', name: 'Daily Tasks Completed', metricSource: 'event_count', eventType: 'task.completed', timeWindow: 'daily' },
  ]
  for (const lb of leaderboards) {
    await db.leaderboard.create({
      data: {
        projectId: project.id, environmentId: env.id,
        code: lb.code, name: lb.name, metricSource: lb.metricSource,
        eventType: lb.eventType ?? null, payloadProperty: lb.payloadProperty ?? null,
        timeWindow: lb.timeWindow, algorithm: 'highest',
        rewardsJson: JSON.stringify([
          { rankFrom: 1, rankTo: 3, rewardsJson: JSON.stringify([{ type: 'grant_reward', params: { reward: 'weekly_bonus' } }]) },
        ]),
      },
    })
  }
  console.log(`✓ Leaderboards: ${leaderboards.length}`)

  // ---- Segments ----
  const segments = [
    { name: 'Newcomers', description: 'XP below 100', conditions: { op: 'and', conditions: [{ field: 'user.xp', operator: 'lt', value: 100 }] } },
    { name: 'Power Users', description: 'Level 5 and above', conditions: { op: 'and', conditions: [{ field: 'user.level', operator: 'gte', value: 5 }] } },
    { name: 'Free Plan', description: 'Everyone without a paid attribute', conditions: { op: 'and', conditions: [{ field: 'user.attribute.plan', operator: 'not_in', value: ['pro', 'team'] }] } },
  ]
  for (const s of segments) {
    await db.segment.create({
      data: { projectId: project.id, environmentId: env.id, name: s.name, description: s.description, conditionsJson: JSON.stringify(s.conditions) },
    })
  }
  console.log(`✓ Segments: ${segments.length}`)

  // ---- Feature flags + experiment + remote config ----
  await db.featureFlag.create({
    data: { projectId: project.id, environmentId: env.id, key: 'season_one', description: 'Season 1 reward tracks', enabled: true, rolloutPercent: 100 },
  })
  await db.featureFlag.create({
    data: { projectId: project.id, environmentId: env.id, key: 'team_challenges', description: 'Team vs team challenges (beta)', enabled: false, rolloutPercent: 25 },
  })
  await db.experiment.create({
    data: {
      projectId: project.id, environmentId: env.id,
      key: 'onboarding_challenge_copy', name: 'Onboarding challenge copy',
      variantsJson: JSON.stringify([
        { key: 'control', name: 'Standard copy', weight: 50 },
        { key: 'playful', name: 'Playful copy', weight: 50 },
      ]),
      trafficPercent: 100, status: 'running',
    },
  })
  await db.remoteConfig.create({
    data: { projectId: project.id, environmentId: env.id, key: 'daily_xp_cap', valueType: 'number', valueJson: '5000' },
  })
  console.log('✓ Flags: 2 · Experiment: 1 · Remote config: 1')

  // ---- API key for the demo (shown here once) ----
  const apiSecret = `gog_${randomBytes(24).toString('hex')}`
  await db.apiKey.create({
    data: {
      projectId: project.id, environmentId: env.id,
      name: 'Demo SDK key (development)',
      keyPrefix: apiSecret.slice(0, 12),
      keyHash: createHash('sha256').update(apiSecret).digest('hex'),
      scopesJson: JSON.stringify(['events:write', 'state:read']),
    },
  })
  console.log(`✓ API key (development): ${apiSecret}`)

  // ---- Season ----
  const now = new Date()
  await db.season.create({
    data: {
      projectId: project.id, name: 'Season 1: Foundations', number: 1,
      startsAt: new Date(now.getTime() - 7 * 86400000), endsAt: new Date(now.getTime() + 83 * 86400000),
      status: 'active', rankResetPolicy: 'soft',
      tracksJson: JSON.stringify([
        { name: 'Free Track', tiers: [{ at: 500, rewardsJson: '[]' }, { at: 2000, rewardsJson: '[]' }] },
        { name: 'Premium Track', tiers: [{ at: 500, rewardsJson: '[]' }, { at: 2000, rewardsJson: '[]' }] },
      ]),
    },
  })
  console.log('✓ Season 1: Foundations (active)')

  // ---- Demo users ----
  const demoUsers = [
    { externalId: 'ada', displayName: 'Ada Lovelace', attributes: { plan: 'pro', country: 'UK' } },
    { externalId: 'grace', displayName: 'Grace Hopper', attributes: { plan: 'free', country: 'US' } },
    { externalId: 'alan', displayName: 'Alan Turing', attributes: { plan: 'team', country: 'UK' } },
  ]
  const userIds: Record<string, string> = {}
  for (const u of demoUsers) {
    const user = await db.appUser.create({
      data: {
        projectId: project.id, environmentId: env.id,
        externalId: u.externalId, displayName: u.displayName,
        isAnonymous: false, attributesJson: JSON.stringify(u.attributes),
        lastSeenAt: new Date(),
      },
    })
    userIds[u.externalId] = user.id
  }
  console.log(`✓ Demo users: ${demoUsers.map((u) => u.externalId).join(', ')}`)

  console.log('\n🎉 Seed complete!\n')
  console.log('   Dashboard login: owner@focusquest.app / gamification123')
  console.log('   Scope: Acme Inc → Product Team → FocusQuest → development\n')
}

main()
  .catch((e) => {
    console.error('Seed failed:', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
