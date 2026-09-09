/**
 * Plugin + marketplace administration (§54/§110-112).
 * GET    — catalog with per-environment install state
 * POST   — { action: install|enable|disable|uninstall, pluginId }
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { listPluginsWithState, installPlugin, setPluginStatus, uninstallPlugin } from '@/server/plugins/service'
import { getActionRegistry } from '@/server/engine/actions'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const plugins = await listPluginsWithState(scope.projectId, scope.environmentId)
    return json({ plugins, scope })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const body = await readJson<{ action?: string; pluginId?: string }>(req)
    if (!body.action || !body.pluginId) {
      return json({ error: { code: 'FIELDS_REQUIRED', message: '"action" (install|enable|disable|uninstall) and "pluginId" are required.' } }, 400)
    }

    let result: Record<string, unknown>
    switch (body.action) {
      case 'install':
        result = await installPlugin({
          pluginId: body.pluginId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          adminUserId: admin.adminUserId,
        })
        break
      case 'enable':
      case 'disable':
        result = await setPluginStatus({
          pluginId: body.pluginId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          status: body.action === 'enable' ? 'enabled' : 'disabled',
          adminUserId: admin.adminUserId,
        })
        break
      case 'uninstall':
        result = await uninstallPlugin({
          pluginId: body.pluginId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          adminUserId: admin.adminUserId,
        })
        break
      default:
        return json({ error: { code: 'ACTION_INVALID', message: `Unknown action "${body.action}".` } }, 400)
    }

    // include the live action registry so the UI can reflect new capabilities
    const actions = getActionRegistry().filter((a) => a.plugin === body.pluginId)
    return json({ ...result, registeredActions: actions.map((a) => a.type) }, 201)
  } catch (e) {
    return apiError(e)
  }
}
