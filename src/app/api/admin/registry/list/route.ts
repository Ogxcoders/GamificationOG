/**
 * GET /api/admin/registry — Capability Registry (Section 2.3).
 * Discovers object types, events, actions, operators, formula functions.
 */
import { NextRequest } from 'next/server'
import { json, apiError } from '@/lib/api'
import { requireAdmin } from '@/lib/admin-auth'
import { getFullRegistry, getRegistrySummary } from '@/server/registry/capability'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    return json({
      registry: getFullRegistry(),
      summary: getRegistrySummary(),
    })
  } catch (e) {
    return apiError(e)
  }
}
