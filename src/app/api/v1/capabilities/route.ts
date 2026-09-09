/**
 * GET /api/v1/capabilities — Capability registry for SDKs and AI agents
 * (MCP control plane, Sections 65, 153; Section 2.3 registry).
 *
 * API-key authenticated, scope: "registry:read". Discovery surface for
 * everything the platform can do: object types, events, actions,
 * operators, formula functions. Agents consult this before composing
 * configuration — no guessing at schema (discoverable, schema-defined,
 * validated — Section 153).
 */
import { NextRequest } from 'next/server'
import { json, apiError, requireApiKey, requireScope } from '@/lib/api'
import { getFullRegistry, getRegistrySummary } from '@/server/registry/capability'

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'registry:read')
    // hydrate enabled plugins so the registry reflects live custom actions
    const { ensureRuntimePlugins } = await import('@/server/plugins/service')
    await ensureRuntimePlugins().catch(() => null)
    return json({
      registry: getFullRegistry(),
      summary: getRegistrySummary(),
    })
  } catch (e) {
    return apiError(e)
  }
}
