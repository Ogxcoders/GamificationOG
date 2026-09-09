/**
 * GamificationOG — Plugin manifest validation (§112, §54).
 * Machine-validated manifests before any capability is registered:
 * ids, versions, platform compatibility ranges, permissions allowlist,
 * action/event definitions. A plugin that cannot be validated cannot
 * be installed — the platform never runs unvalidated manifests.
 */
import { PlatformError } from '@/server/core/errors'

export type PluginTrustLevel = 'first-party' | 'verified' | 'trusted' | 'sandboxed' | 'untrusted'

export interface PluginActionDef {
  type: string // action type, e.g. "skilltree.unlock_node"
  domain: string
  description: string
  params: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'json'; required: boolean; description?: string }>
}

export interface PluginEventDef {
  name: string // event type, e.g. "quiz.answered"
  version: number
  description?: string
  payloadSchema?: Record<string, { type: string; required?: boolean }>
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  platform_version: string // e.g. ">=1.0 <2.0"
  description?: string
  trust: PluginTrustLevel
  requires: string[] // capability ids the plugin depends on
  provides: string[] // capability ids the plugin provides
  permissions: string[] // §55 permission manifest
  actions: PluginActionDef[]
  events: PluginEventDef[]
}

/** §55 permission allowlist — what a plugin may request. */
export const PLUGIN_PERMISSIONS = [
  'events.read',
  'events.write',
  'state.read',
  'state.write',
  'progression.write',
  'economy.read',
  'notifications.write',
] as const

const PLATFORM_VERSION = '1.0.0' // current platform (schema/engine) version

function fail(code: string, message: string, fix?: string): never {
  throw new PlatformError({ code, category: 'validation', message, fix })
}

const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/ // reverse-DNS
const SEMVER_RE = /^\d+\.\d+\.\d+$/

/** Parse a simple version range: ">=1.0 <2.0", ">=1.2", "=1.0.0". */
export function parseVersionRange(range: string): Array<{ op: '>=' | '<' | '=' | '>' | '<=' | '!=' ; version: string }> {
  const parts = range.split(/\s+/).filter(Boolean)
  const out: Array<{ op: '>=' | '<' | '=' | '>' | '<=' | '!='; version: string }> = []
  for (const p of parts) {
    const m = p.match(/^(>=|<=|>|<|=|!=)?(\d+(?:\.\d+){0,2})$/)
    if (!m) return []
    out.push({ op: (m[1] ?? '>=') as '>=' , version: m[2] })
  }
  return out
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function versionSatisfies(version: string, range: string): boolean {
  const constraints = parseVersionRange(range)
  if (constraints.length === 0) return false
  return constraints.every(({ op, version: v }) => {
    const c = cmpVersion(version, v)
    switch (op) {
      case '>=': return c >= 0
      case '<': return c < 0
      case '>': return c > 0
      case '<=': return c <= 0
      case '=': return c === 0
      case '!=': return c !== 0
    }
  })
}

/** Validate a plugin manifest (§112 "machine-validated"). Throws PlatformError. */
export function validatePluginManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('PLUGIN_MANIFEST_INVALID', 'Plugin manifest must be an object.')
  }
  const m = raw as Record<string, unknown>

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    fail('PLUGIN_MANIFEST_INVALID', `Plugin "id" must be reverse-DNS (e.g. com.example.plugin), got "${String(m.id)}".`)
  }
  if (typeof m.name !== 'string' || m.name.length < 2) {
    fail('PLUGIN_MANIFEST_INVALID', 'Plugin "name" is required (min 2 chars).')
  }
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) {
    fail('PLUGIN_MANIFEST_INVALID', `Plugin "version" must be semver (x.y.z), got "${String(m.version)}".`)
  }
  if (typeof m.platform_version !== 'string' || parseVersionRange(m.platform_version).length === 0) {
    fail('PLUGIN_MANIFEST_INVALID', `Plugin "platform_version" must be a range like ">=1.0 <2.0", got "${String(m.platform_version)}".`)
  }
  const trust = m.trust as PluginTrustLevel
  if (!['first-party', 'verified', 'trusted', 'sandboxed', 'untrusted'].includes(trust)) {
    fail('PLUGIN_MANIFEST_INVALID', `Plugin "trust" must be one of first-party|verified|trusted|sandboxed|untrusted (§56).`)
  }

  const requires = Array.isArray(m.requires) ? m.requires.map(String) : fail('PLUGIN_MANIFEST_INVALID', '"requires" must be an array of capability ids.')
  const provides = Array.isArray(m.provides) ? m.provides.map(String) : fail('PLUGIN_MANIFEST_INVALID', '"provides" must be an array of capability ids.')
  const permissions = Array.isArray(m.permissions) ? m.permissions.map(String) : []

  for (const p of permissions) {
    if (!(PLUGIN_PERMISSIONS as readonly string[]).includes(p)) {
      fail('PLUGIN_PERMISSION_DENIED', `Permission "${p}" is not in the plugin permission allowlist (§55).`, `Allowed: ${PLUGIN_PERMISSIONS.join(', ')}`)
    }
  }

  const actions: PluginActionDef[] = []
  if (m.actions !== undefined) {
    if (!Array.isArray(m.actions)) fail('PLUGIN_MANIFEST_INVALID', '"actions" must be an array.')
    for (const a of m.actions as Array<Record<string, unknown>>) {
      if (typeof a.type !== 'string' || !/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(a.type)) {
        fail('PLUGIN_MANIFEST_INVALID', `Action type "${String(a.type)}" must be namespaced (e.g. skilltree.unlock_node).`)
      }
      if (typeof a.domain !== 'string' || !a.domain) fail('PLUGIN_MANIFEST_INVALID', `Action "${String(a.type)}" needs a domain.`)
      if (typeof a.description !== 'string' || !a.description) fail('PLUGIN_MANIFEST_INVALID', `Action "${String(a.type)}" needs a description.`)
      if (!Array.isArray(a.params)) fail('PLUGIN_MANIFEST_INVALID', `Action "${String(a.type)}" needs a params array (§ typed contract).`)
      actions.push({
        type: a.type,
        domain: a.domain,
        description: a.description,
        params: (a.params as Array<Record<string, unknown>>).map((p) => ({
          name: String(p.name),
          type: (p.type as PluginActionDef['params'][number]['type']) ?? 'string',
          required: p.required !== false,
          description: p.description ? String(p.description) : undefined,
        })),
      })
    }
  }

  const events: PluginEventDef[] = []
  if (m.events !== undefined) {
    if (!Array.isArray(m.events)) fail('PLUGIN_MANIFEST_INVALID', '"events" must be an array.')
    for (const e of m.events as Array<Record<string, unknown>>) {
      if (typeof e.name !== 'string' || !/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(e.name)) {
        fail('PLUGIN_MANIFEST_INVALID', `Event name "${String(e.name)}" must be namespaced (e.g. quiz.answered).`)
      }
      events.push({
        name: e.name,
        version: Number(e.version ?? 1) || 1,
        description: e.description ? String(e.description) : undefined,
        payloadSchema: (e.payloadSchema as PluginEventDef['payloadSchema']) ?? {},
      })
    }
  }

  // platform compatibility (§ "A plugin cannot require an unsupported engine version")
  if (!versionSatisfies(PLATFORM_VERSION, m.platform_version as string)) {
    fail('PLUGIN_INCOMPATIBLE', `Plugin requires platform ${m.platform_version}; this platform is ${PLATFORM_VERSION}.`, 'Update the plugin or the platform.')
  }

  return {
    id: m.id,
    name: m.name,
    version: m.version,
    platform_version: m.platform_version as string,
    description: m.description ? String(m.description) : undefined,
    trust,
    requires,
    provides,
    permissions,
    actions,
    events,
  }
}
