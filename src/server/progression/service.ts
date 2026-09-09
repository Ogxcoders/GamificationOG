/**
 * GamificationOG — Progression Service (Section 20)
 * Progression must not assume RPG levels. Configurable per track:
 * linear, exponential, or custom formula. Multiple parallel tracks supported.
 */
import { db } from '@/lib/db'
import { parseJson } from '../core/types'
import { evaluateFormula } from '../engine/formula'

export interface XpAwardResult {
  track: string
  xpAwarded: number
  xpBefore: number
  xpAfter: number
  levelBefore: number
  levelAfter: number
  levelUp: boolean
}

/** Compute level for a track configuration given total xp. */
export function computeLevel(
  config: {
    type: string // linear | exponential | custom
    baseXpPerLevel: number
    growthFactor: number
    maxLevel: number
    customFormulaJson?: string | null
  },
  xp: number,
): number {
  let level = 1
  switch (config.type) {
    case 'linear': {
      if (config.baseXpPerLevel <= 0) return 1
      level = Math.floor(xp / config.baseXpPerLevel) + 1
      break
    }
    case 'exponential': {
      // cumulative XP for level L: base * factor^(L-1)
      let required = config.baseXpPerLevel
      let cumulative = 0
      level = 1
      while (cumulative + required <= xp && level < config.maxLevel) {
        cumulative += required
        required = Math.round(required * (config.growthFactor > 1 ? config.growthFactor : 1.15))
        level++
      }
      break
    }
    case 'custom': {
      const formula = parseJson<{ levelFormula?: string }>(config.customFormulaJson, {}).levelFormula
      if (formula) {
        try {
          level = Math.max(1, Math.floor(evaluateFormula(formula, { xp })))
        } catch {
          level = Math.floor(xp / Math.max(1, config.baseXpPerLevel)) + 1
        }
      } else {
        level = Math.floor(xp / Math.max(1, config.baseXpPerLevel)) + 1
      }
      break
    }
    default:
      level = Math.floor(xp / Math.max(1, config.baseXpPerLevel)) + 1
  }
  return Math.min(Math.max(1, level), config.maxLevel)
}

/** XP required to reach the next level from current xp. */
export function xpForNextLevel(
  config: { type: string; baseXpPerLevel: number; growthFactor: number; maxLevel: number; customFormulaJson?: string | null },
  xp: number,
): number {
  const level = computeLevel(config, xp)
  if (level >= config.maxLevel) return 0
  // find minimum xp that produces level+1
  let lo = xp
  let hi = Math.max(xp * 2, config.baseXpPerLevel * 1000)
  for (let i = 0; i < 64; i++) {
    const mid = Math.floor((lo + hi) / 2)
    if (computeLevel(config, mid) > level) hi = mid
    else lo = mid + 1
  }
  return hi
}

export async function awardXp(params: {
  projectId: string
  environmentId: string
  appUserId: string
  trackCode?: string
  amount: number
  source?: string
  reference?: string
  correlationId?: string
  causationId?: string
  idempotencyKey?: string
}): Promise<XpAwardResult> {
  const trackCode = params.trackCode ?? 'default'
  const track = await db.progressionTrack.findUnique({
    where: { projectId_environmentId_code: { projectId: params.projectId, environmentId: params.environmentId, code: trackCode } },
  })

  if (!track) {
    // auto-create default track lazily — progression must always work
    const created = await db.progressionTrack.create({
      data: {
        projectId: params.projectId,
        environmentId: params.environmentId,
        code: trackCode,
        name: trackCode === 'default' ? 'Default Progression' : trackCode,
        type: 'linear',
        baseXpPerLevel: 100,
        growthFactor: 1.0,
        maxLevel: 100,
      },
    })
    return awardXpWithTrack(created, params)
  }

  return awardXpWithTrack(track, params)
}

async function awardXpWithTrack(
  track: { id: string; code: string; type: string; baseXpPerLevel: number; growthFactor: number; maxLevel: number; customFormulaJson: string | null },
  params: {
    appUserId: string
    amount: number
    source?: string
    reference?: string
    correlationId?: string
    causationId?: string
    idempotencyKey?: string
  },
): Promise<XpAwardResult> {
  if (!Number.isFinite(params.amount) || params.amount === 0) {
    throw new Error('XP amount must be a non-zero finite number')
  }
  if (params.amount < 0) {
    throw new Error('Use remove XP semantics via negative-capable ledger; direct negative XP requires admin flow')
  }

  const config = {
    type: track.type,
    baseXpPerLevel: track.baseXpPerLevel,
    growthFactor: track.growthFactor,
    maxLevel: track.maxLevel,
    customFormulaJson: track.customFormulaJson,
  }

  const progress = await db.userProgression.upsert({
    where: { appUserId_trackId: { appUserId: params.appUserId, trackId: track.id } },
    create: { appUserId: params.appUserId, trackId: track.id, xp: 0, level: 1 },
    update: {},
  })

  const xpBefore = progress.xp
  const levelBefore = progress.level
  const xpAfter = xpBefore + params.amount
  const levelAfter = computeLevel(config, xpAfter)

  await db.userProgression.update({
    where: { id: progress.id },
    data: { xp: xpAfter, level: levelAfter },
  })

  return {
    track: track.code,
    xpAwarded: params.amount,
    xpBefore,
    xpAfter,
    levelBefore,
    levelAfter,
    levelUp: levelAfter > levelBefore,
  }
}

export async function getUserProgression(appUserId: string) {
  const rows = await db.userProgression.findMany({
    where: { appUserId },
    include: { track: true },
  })
  return rows.map((r) => {
    const config = {
      type: r.track.type,
      baseXpPerLevel: r.track.baseXpPerLevel,
      growthFactor: r.track.growthFactor,
      maxLevel: r.track.maxLevel,
      customFormulaJson: r.track.customFormulaJson,
    }
    const nextXp = xpForNextLevel(config, r.xp)
    const currentLevelXp = nextXp > 0 ? xpForNextLevel(config, r.xp - 1) : r.xp
    return {
      track: r.track.code,
      trackName: r.track.name,
      xp: r.xp,
      level: r.level,
      maxLevel: r.track.maxLevel,
      xpForNextLevel: nextXp,
      xpIntoLevel: Math.max(0, r.xp - (currentLevelXp - (nextXp - currentLevelXp) || 0)),
      progressPercent: nextXp > 0 ? Math.min(100, Math.round((r.xp / nextXp) * 100)) : 100,
    }
  })
}

export async function getLevelForContext(appUserId: string, trackCode = 'default'): Promise<{ xp: number; level: number }> {
  const row = await db.userProgression.findFirst({
    where: { appUserId, track: { code: trackCode } },
  })
  return row ? { xp: row.xp, level: row.level } : { xp: 0, level: 1 }
}
