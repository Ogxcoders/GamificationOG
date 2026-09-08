/**
 * GET  /api/admin/monetization — monetization overview: products, offers,
 *       paywalls, subscriptions, entitlements, recent checkouts.
 * POST /api/admin/monetization — actions:
 *   { action: 'reconcile' }        — §202 entitlement reconciliation
 *   { action: 'cancel_subscription', user, product_code }
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson } from '@/lib/api'
import { db } from '@/lib/db'
import { requireAdmin, resolveScope } from '@/lib/admin-auth'
import { parseJson } from '@/server/core/types'
import { reconcileEntitlements, cancelSubscription } from '@/server/monetization/service'
import { recordAudit } from '@/server/audit/service'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
    const scope = await resolveScope(req)

    const [products, offers, paywalls, subscriptions, entitlements, checkouts] = await Promise.all([
      db.product.findMany({
        where: { projectId: scope.projectId, environmentId: scope.environmentId },
        orderBy: { createdAt: 'desc' },
      }),
      db.offer.findMany({
        where: { projectId: scope.projectId, environmentId: scope.environmentId },
        orderBy: { priority: 'desc' },
      }),
      db.paywall.findMany({
        where: { projectId: scope.projectId, environmentId: scope.environmentId },
        orderBy: { createdAt: 'desc' },
      }),
      db.subscription.findMany({
        where: { projectId: scope.projectId, environmentId: scope.environmentId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { appUser: { select: { externalId: true, displayName: true } }, product: { select: { name: true } } },
      }),
      db.entitlement.findMany({
        where: { projectId: scope.projectId, environmentId: scope.environmentId },
        orderBy: { updatedAt: 'desc' },
        take: 100,
        include: { appUser: { select: { externalId: true, displayName: true } } },
      }),
      db.checkoutSession.findMany({
        where: { projectId: scope.projectId, environmentId: scope.environmentId },
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: { appUser: { select: { externalId: true, displayName: true } } },
      }),
    ])

    return json({
      products: products.map((p) => ({
        id: p.id, code: p.code, name: p.name, description: p.description, type: p.type,
        priceTiers: parseJson<Array<Record<string, unknown>>>(p.priceTiersJson, []),
        entitlementCode: p.entitlementCode, status: p.status,
      })),
      offers: offers.map((o) => ({
        id: o.id, code: o.code, name: o.name, productCode: o.productCode,
        pricing: parseJson<Record<string, unknown>>(o.pricingJson, {}),
        targeting: parseJson<Record<string, unknown>>(o.targetingJson, {}),
        priority: o.priority, startsAt: o.startsAt, endsAt: o.endsAt, status: o.status,
      })),
      paywalls: paywalls.map((w) => ({
        id: w.id, code: w.code, name: w.name, entitlementCode: w.entitlementCode,
        offers: parseJson<string[]>(w.offersJson, []), config: parseJson<Record<string, unknown>>(w.configJson, {}),
        status: w.status,
      })),
      subscriptions: subscriptions.map((s) => ({
        id: s.id, user: s.appUser.displayName ?? s.appUser.externalId, product: s.product.name,
        productCode: s.productCode, tier: s.tier, status: s.status,
        currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        price: parseJson<Record<string, unknown>>(s.priceJson, {}), provider: s.provider,
      })),
      entitlements: entitlements.map((e) => ({
        id: e.id, user: e.appUser.displayName ?? e.appUser.externalId, code: e.code,
        source: e.source, status: e.status, endsAt: e.endsAt,
      })),
      recentCheckouts: checkouts.map((c) => ({
        id: c.id, user: c.appUser.displayName ?? c.appUser.externalId, productCode: c.productCode,
        offerCode: c.offerCode, status: c.status, price: parseJson<Record<string, unknown>>(c.priceJson, {}),
        createdAt: c.createdAt, completedAt: c.completedAt,
      })),
      summary: {
        activeSubscriptions: subscriptions.filter((s) => ['active', 'trialing'].includes(s.status)).length,
        activeEntitlements: entitlements.filter((e) => e.status === 'active').length,
        completedCheckouts: checkouts.filter((c) => c.status === 'completed').length,
        revenueEstimate: checkouts
          .filter((c) => c.status === 'completed')
          .reduce((sum, c) => sum + (parseJson<{ amount?: number }>(c.priceJson, {}).amount ?? 0), 0),
      },
      scope,
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req)
    const scope = await resolveScope(req)
    const body = await readJson<{ action: string; user?: string; product_code?: string }>(req)

    if (body.action === 'reconcile') {
      const result = await reconcileEntitlements(scope.projectId, scope.environmentId)
      await recordAudit({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        actorType: 'human',
        actorId: admin.adminUserId,
        action: 'monetization.reconciled',
        targetType: 'monetization',
        targetId: 'reconcile',
        afterJson: JSON.stringify(result),
      })
      return json({ ok: true, result })
    }

    if (body.action === 'cancel_subscription') {
      if (!body.user || !body.product_code) {
        return json({ error: { code: 'FIELDS_REQUIRED', message: 'Fields "user" and "product_code" are required.' } }, 400)
      }
      const user = await db.appUser.findUnique({
        where: {
          projectId_environmentId_externalId: {
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            externalId: body.user,
          },
        },
      })
      if (!user) return json({ error: { code: 'USER_NOT_FOUND', message: 'User not found.' } }, 404)
      const result = await cancelSubscription(scope.projectId, scope.environmentId, user.id, body.product_code)
      await recordAudit({
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        actorType: 'human',
        actorId: admin.adminUserId,
        action: 'subscription.canceled',
        targetType: 'subscription',
        targetId: `${body.user}:${body.product_code}`,
        afterJson: JSON.stringify(result),
      })
      return json({ ok: true, result })
    }

    return json({ error: { code: 'UNKNOWN_ACTION', message: 'Use reconcile or cancel_subscription.' } }, 400)
  } catch (e) {
    return apiError(e)
  }
}
