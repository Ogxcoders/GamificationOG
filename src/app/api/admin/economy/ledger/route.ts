/**
 * GET /api/admin/economy — currencies + wallets + ledger view (Section 27).
 * POST /api/admin/economy — rebuild wallet projections / verify integrity.
 * Economy endpoints: GET ledger history, POST { action: 'rebuild' | 'verify' }.
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { getLedgerHistory, rebuildWalletProjection, verifyEconomyIntegrity } from '@/server/economy/service'
import { recordAudit } from '@/server/audit/service'
import { parseJson } from '@/server/core/types'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)
    const url = new URL(req.url)
    const ledgerFor = url.searchParams.get('ledgerFor') // app user id

    const currencies = await db.currency.findMany({
      where: { projectId: scope.projectId, environmentId: scope.environmentId },
      orderBy: { createdAt: 'asc' },
    })

    const totalSupply = await Promise.all(
      currencies.map(async (c) => ({
        code: c.code,
        supply: await db.walletBalance.aggregate({ where: { currencyId: c.id }, _sum: { balance: true } }).then((a) => a._sum.balance ?? 0),
        holders: await db.walletBalance.count({ where: { currencyId: c.id, balance: { gt: 0 } } }),
      })),
    )

    const ledger = await getLedgerHistory({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      appUserId: ledgerFor ?? undefined,
      limit: 60,
    })

    const topWallets = await db.walletBalance.findMany({
      where: { walletBalances_project: undefined } as never,
      orderBy: { balance: 'desc' },
      take: 0,
    }).catch(() => []) // placeholder no-op

    return json({
      currencies: currencies.map((c) => ({
        ...c,
        capConfig: parseJson<Record<string, unknown>>(c.capConfigJson, {}),
      })),
      totalSupply,
      ledger: ledger.map((t) => ({
        id: t.id,
        user: t.appUser ? (t.appUser.displayName ?? t.appUser.externalId) : null,
        currency: t.currency.code,
        amount: t.amount,
        type: t.type,
        source: t.source,
        reason: t.reason,
        balanceAfter: t.balanceAfter,
        createdAt: t.createdAt,
      })),
      scope,
      topWallets,
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const body = await readJson<{ action: 'rebuild' | 'verify' }>(req)

    if (body.action === 'rebuild') {
      const result = await rebuildWalletProjection(scope.projectId, scope.environmentId)
      await recordAudit({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        actorType: 'human',
        actorId: admin.adminUserId,
        action: 'economy.rebuilt_projections',
        targetType: 'economy',
        afterJson: JSON.stringify(result),
      })
      return json({ ok: true, ...result })
    }

    if (body.action === 'verify') {
      const results = await verifyEconomyIntegrity(scope.projectId, scope.environmentId)
      return json({ ok: true, currencies: results })
    }

    return json({ error: { code: 'UNKNOWN_ACTION', message: 'Use rebuild or verify.' } }, 400)
  } catch (e) {
    return apiError(e)
  }
}
