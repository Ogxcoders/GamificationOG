/**
 * GamificationOG — Built-in plugin catalog (§54, § Phase 5 marketplace).
 *
 * First-party, manifest-validated extension modules proving the plugin SDK:
 * custom actions register into the live engine registry, custom event
 * schemas register into the project's event catalog, and the marketplace
 * lists trust level + permissions + install state per project.
 */
import type { PluginManifest } from './manifest'
import { PlatformError } from '@/server/core/errors'
import { db } from '@/lib/db'
import type { ActionContext } from '@/server/engine/actions'

export interface PluginModule {
  manifest: PluginManifest
  /** Register runtime capabilities (called on enable). */
  register: (ctx: { projectId: string; environmentId: string }) => Promise<void>
  /** Tear down runtime capabilities (called on disable/uninstall). */
  unregister: () => void
}

// ---------------------------------------------------------------------------
// shared helpers for plugin action implementations
// ---------------------------------------------------------------------------

async function getUserVariable(appUserId: string, key: string): Promise<unknown> {
  const row = await db.userVariable.findUnique({ where: { appUserId_key: { appUserId, key } } })
  if (!row) return null
  try {
    return JSON.parse(row.valueJson)
  } catch {
    return row.valueJson
  }
}

async function setUserVariable(appUserId: string, key: string, value: unknown) {
  await db.userVariable.upsert({
    where: { appUserId_key: { appUserId, key } },
    create: { appUserId, key, valueJson: JSON.stringify(value) },
    update: { valueJson: JSON.stringify(value) },
  })
}

// ---------------------------------------------------------------------------
// Plugin 1: Skill Tree (§113 example — composed from universal primitives)
// ---------------------------------------------------------------------------

const skilltree: PluginModule = {
  manifest: {
    id: 'com.gog.skilltree',
    name: 'Skill Tree',
    version: '1.0.0',
    platform_version: '>=1.0 <2.0',
    description: 'Branching skill progression: unlock nodes with skill points, track mastery per skill.',
    trust: 'first-party',
    requires: ['core.events', 'core.rules'],
    provides: ['skilltree.nodes', 'skilltree.points'],
    permissions: ['state.read', 'state.write'],
    actions: [
      {
        type: 'skilltree.unlock_node',
        domain: 'skilltree',
        description: 'Unlock a skill node (spends skill points, records the node)',
        params: [
          { name: 'node', type: 'string', required: true, description: 'Skill node id, e.g. "focus.deep_work"' },
          { name: 'cost', type: 'number', required: false, description: 'Skill points to spend (default 1)' },
        ],
      },
      {
        type: 'skilltree.award_points',
        domain: 'skilltree',
        description: 'Award skill points to the user',
        params: [{ name: 'amount', type: 'number', required: true, description: 'Points to award (number or formula)' }],
      },
    ],
    events: [
      {
        name: 'skill.node_practiced',
        version: 1,
        description: 'User practiced a skill node',
        payloadSchema: { node: { type: 'string', required: true }, minutes: { type: 'number' } },
      },
    ],
  },
  async register() {
    const { registerExternalAction } = await import('@/server/engine/actions')
    const { evaluateFormula } = await import('@/server/engine/formula')

    registerExternalAction(
      'skilltree.unlock_node',
      'skilltree',
      'Unlock a skill node (spends skill points, records the node)',
      async (params, ctx: ActionContext) => {
        const node = typeof params.node === 'string' && params.node ? params.node : null
        if (!node) {
          throw new PlatformError({ code: 'ACTION_INVALID_PARAM', category: 'engine', message: 'skilltree.unlock_node requires "node" (string).' })
        }
        const cost = typeof params.cost === 'number' ? Math.max(0, Math.round(params.cost)) : 1
        const points = (await getUserVariable(ctx.appUserId, 'skill_points') as number | null) ?? 0
        const nodes = (await getUserVariable(ctx.appUserId, 'skill_nodes') as string[] | null) ?? []
        if (nodes.includes(node)) return { detail: `Skill node "${node}" already unlocked`, skipped: true }
        if (points < cost) return { detail: `Insufficient skill points (${points} < ${cost})`, skipped: true }
        await setUserVariable(ctx.appUserId, 'skill_points', points - cost)
        await setUserVariable(ctx.appUserId, 'skill_nodes', [...nodes, node])
        return {
          detail: `Unlocked skill node "${node}" for ${cost} point(s); ${points - cost} remaining`,
          before: { points, nodes: nodes.length },
          after: { points: points - cost, nodes: nodes.length + 1 },
        }
      },
      'com.gog.skilltree',
    )

    registerExternalAction(
      'skilltree.award_points',
      'skilltree',
      'Award skill points to the user',
      async (params, ctx: ActionContext) => {
        const raw = params.amount
        const amount =
          typeof raw === 'number'
            ? Math.round(raw)
            : typeof raw === 'string' && raw.trim()
              ? Math.round(evaluateFormula(raw, (ctx.formulaVariables ?? {}) as never))
              : NaN
        if (!Number.isFinite(amount) || amount <= 0) return { detail: 'Skipped: non-positive skill points', skipped: true }
        const points = ((await getUserVariable(ctx.appUserId, 'skill_points') as number | null) ?? 0) + amount
        await setUserVariable(ctx.appUserId, 'skill_points', points)
        return { detail: `Skill points +${amount} → ${points}`, after: { points } }
      },
      'com.gog.skilltree',
    )
  },
  unregister() {
    // handled centrally by unregisterActionsByPlugin
  },
}

// ---------------------------------------------------------------------------
// Plugin 2: Quiz Engine (adaptive difficulty)
// ---------------------------------------------------------------------------

const quizengine: PluginModule = {
  manifest: {
    id: 'com.gog.quizengine',
    name: 'Quiz Engine',
    version: '1.2.0',
    platform_version: '>=1.0 <2.0',
    description: 'Adaptive quiz difficulty: tracks correctness ratio and adjusts the next difficulty band.',
    trust: 'first-party',
    requires: ['core.events'],
    provides: ['quiz.difficulty'],
    permissions: ['state.read', 'state.write'],
    actions: [
      {
        type: 'quiz.record_answer',
        domain: 'quiz',
        description: 'Record a quiz answer and recompute the adaptive difficulty',
        params: [
          { name: 'correct', type: 'boolean', required: true, description: 'Whether the answer was correct' },
          { name: 'reset', type: 'boolean', required: false, description: 'Reset the rolling window' },
        ],
      },
    ],
    events: [
      {
        name: 'quiz.answered',
        version: 1,
        description: 'A quiz answer was submitted',
        payloadSchema: { correct: { type: 'boolean', required: true }, difficulty: { type: 'string' } },
      },
    ],
  },
  async register() {
    const { registerExternalAction } = await import('@/server/engine/actions')

    registerExternalAction(
      'quiz.record_answer',
      'quiz',
      'Record a quiz answer and recompute the adaptive difficulty',
      async (params, ctx: ActionContext) => {
        if (typeof params.correct !== 'boolean') {
          throw new PlatformError({ code: 'ACTION_INVALID_PARAM', category: 'engine', message: 'quiz.record_answer requires "correct" (boolean).' })
        }
        if (params.reset === true) {
          await setUserVariable(ctx.appUserId, 'quiz_correct', 0)
          await setUserVariable(ctx.appUserId, 'quiz_total', 0)
          await setUserVariable(ctx.appUserId, 'quiz_difficulty', 'medium')
          return { detail: 'Quiz stats reset (difficulty → medium)', after: { difficulty: 'medium' } }
        }
        const correct = ((await getUserVariable(ctx.appUserId, 'quiz_correct') as number | null) ?? 0) + (params.correct ? 1 : 0)
        const total = ((await getUserVariable(ctx.appUserId, 'quiz_total') as number | null) ?? 0) + 1
        // adaptive banding: <0.4 easy, <0.75 medium, else hard
        const ratio = correct / total
        const difficulty = ratio < 0.4 ? 'easy' : ratio < 0.75 ? 'medium' : 'hard'
        await setUserVariable(ctx.appUserId, 'quiz_correct', correct)
        await setUserVariable(ctx.appUserId, 'quiz_total', total)
        await setUserVariable(ctx.appUserId, 'quiz_difficulty', difficulty)
        return {
          detail: `Quiz ${correct}/${total} (${Math.round(ratio * 100)}%) → difficulty ${difficulty}`,
          before: undefined,
          after: { correct, total, difficulty },
        }
      },
      'com.gog.quizengine',
    )
  },
  unregister() {},
}

// ---------------------------------------------------------------------------
// Plugin 3: Future/incompatible (install-time version guard demonstrator)
// ---------------------------------------------------------------------------

export const INCOMPATIBLE_PLUGIN_ID = 'com.gog.polaris-preview'
const polaris: PluginModule = {
  manifest: {
    id: INCOMPATIBLE_PLUGIN_ID,
    name: 'Polaris Preview (future API)',
    version: '0.9.0',
    // deliberately incompatible: requires a future platform
    platform_version: '>=99.0',
    description: 'Demonstrates the platform-version install guard (requires a future platform version).',
    trust: 'untrusted',
    requires: ['core.events'],
    provides: ['polaris.preview'],
    permissions: ['events.read'],
    actions: [],
    events: [],
  },
  async register() {
    // never reached: install is rejected by the version guard
  },
  unregister() {},
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const PLUGIN_CATALOG: PluginModule[] = [skilltree, quizengine, polaris]

export function findPluginModule(pluginId: string): PluginModule | undefined {
  return PLUGIN_CATALOG.find((p) => p.manifest.id === pluginId)
}

/**
 * Public catalog surface (validated manifests, no runtime internals).
 * `installState` is merged per project by the service layer.
 */
export function pluginCatalogPublic() {
  return PLUGIN_CATALOG.map((p) => ({
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    description: p.manifest.description,
    trust: p.manifest.trust,
    requires: p.manifest.requires,
    provides: p.manifest.provides,
    permissions: p.manifest.permissions,
    actions: p.manifest.actions,
    events: p.manifest.events,
    compatible: p.manifest.platform_version,
  }))
}
