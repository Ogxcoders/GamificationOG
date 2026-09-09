/**
 * GamificationOG — Monetization service (Sections 37-45, 201, 202).
 * Fourth vertical slice: Offer → Paywall → Checkout → Subscription →
 * Entitlement (§328). Payment providers are abstracted (§41): the
 * bundled "simulated" provider completes the loop locally; real
 * providers implement the same contract (create session / complete).
 *
 * Invariants honored:
 * - Entitlements are projections reconciled from sources (§202/§40)
 * - Every grant is idempotent via (user, code) upsert + source refs
 * - Checkout completion is exactly-once per session (status transition)
 * - Virtual-currency product grants flow through the ledger (§204)
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { PlatformError } from '@/server/core/errors'
import { parseJson, type ConditionNode } from '@/server/core/types'
import { evaluateCondition } from '@/server/engine/condition'
import { postLedgerTransaction } from '@/server/economy/service'

// ---------------------------------------------------------------------------
// Targeting context (§44) — reused for offers, paywalls, personalization
// ---------------------------------------------------------------------------

export async function buildTargetingContext(projectId: string, environmentId: string, appUserId: string): Promise<Record<string, unknown>> {
  const user = await db.appUser.findUnique({ where: { id: appUserId } })
  if (!user) {
    throw new PlatformError({ code: 'USER_NOT_FOUND', category: 'not_found', message: 'User not found.' })
  }
  const attributes = parseJson<Record<string, unknown>>(user.attributesJson, {})
  const [wallets, progression] = await Promise.all([
    db.walletBalance.findMany({ where: { appUserId }, include: { currency: true } }),
    db.userProgression.findFirst({ where: { appUserId } }),
  ])
  const subscriptions = await db.subscription.findMany({
    where: { projectId, environmentId, appUserId, status: { in: ['active', 'trialing'] } },
    select: { productCode: true, tier: true },
  })
  const entitlements = await db.entitlement.findMany({
    where: { projectId, environmentId, appUserId, status: 'active' },
    select: { code: true },
  })
  return {
    user: {
      id: user.id,
      external_id: user.externalId,
      display_name: user.displayName,
      anonymous: user.isAnonymous,
      created_at: user.createdAt.toISOString(),
      attribute: attributes,
      level: progression?.level ?? 1,
      xp: progression?.xp ?? 0,
      currency: Object.fromEntries(wallets.map((w) => [w.currency.code, w.balance])),
      subscription: Object.fromEntries(subscriptions.map((s) => [s.productCode, s.tier ?? true])),
      entitlement: Object.fromEntries(entitlements.map((e) => [e.code, true])),
    },
    time: {
      now: new Date().toISOString(),
      day_of_week: new Date().getUTCDay(),
      hour_of_day: new Date().getUTCHours(),
    },
  }
}

export function matchesTargeting(targetingJson: string, context: Record<string, unknown>): boolean {
  const tree = parseJson<ConditionNode | null>(targetingJson, null)
  if (!tree || (Array.isArray(tree.conditions) && tree.conditions.length === 0)) return true
  return evaluateCondition(tree, context)
}

// ---------------------------------------------------------------------------
// Entitlements (§40, §202)
// ---------------------------------------------------------------------------

export async function grantEntitlement(params: {
  projectId: string
  environmentId: string
  appUserId: string
  code: string
  source?: string
  sourceRef?: string
  durationDays?: number | null // null = permanent
  metadata?: Record<string, unknown>
}) {
  const endsAt = params.durationDays ? new Date(Date.now() + params.durationDays * 86400000) : null
  const existing = await db.entitlement.findUnique({
    where: { projectId_environmentId_appUserId_code: { projectId: params.projectId, environmentId: params.environmentId, appUserId: params.appUserId, code: params.code } },
  })

  // renewal semantics: extend from max(now, current end) for time-boxed grants
  let computedEnd = endsAt
  if (existing && existing.status === 'active' && existing.endsAt && endsAt) {
    computedEnd = existing.endsAt > new Date() ? new Date(Math.max(existing.endsAt.getTime(), endsAt.getTime())) : endsAt
  }

  const entitlement = await db.entitlement.upsert({
    where: { projectId_environmentId_appUserId_code: { projectId: params.projectId, environmentId: params.environmentId, appUserId: params.appUserId, code: params.code } },
    create: {
      projectId: params.projectId, environmentId: params.environmentId, appUserId: params.appUserId,
      code: params.code, source: params.source ?? 'grant', sourceRef: params.sourceRef,
      status: 'active', startsAt: new Date(), endsAt: computedEnd,
      metadataJson: JSON.stringify(params.metadata ?? {}),
    },
    update: {
      status: 'active', source: params.source ?? 'grant', sourceRef: params.sourceRef,
      endsAt: computedEnd, metadataJson: JSON.stringify(params.metadata ?? {}),
    },
  })
  return { entitlement, renewed: !!existing }
}

export async function revokeEntitlement(projectId: string, environmentId: string, appUserId: string, code: string, reason: string) {
  const updated = await db.entitlement.updateMany({
    where: { projectId, environmentId, appUserId, code, status: 'active' },
    data: { status: 'revoked', metadataJson: JSON.stringify({ revokedReason: reason, revokedAt: new Date().toISOString() }) },
  })
  return updated.count > 0
}

export async function getUserEntitlements(projectId: string, environmentId: string, appUserId: string) {
  const now = new Date()
  const rows = await db.entitlement.findMany({ where: { projectId, environmentId, appUserId } })
  // lazily expire time-boxed rows
  const expired = rows.filter((r) => r.status === 'active' && r.endsAt && r.endsAt < now)
  if (expired.length > 0) {
    await db.entitlement.updateMany({
      where: { id: { in: expired.map((r) => r.id) } },
      data: { status: 'expired' },
    })
    for (const r of expired) r.status = 'expired'
  }
  return rows.map((r) => ({
    code: r.code,
    source: r.source,
    status: r.status,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
  }))
}

export async function hasActiveEntitlement(projectId: string, environmentId: string, appUserId: string, code: string): Promise<boolean> {
  const row = await db.entitlement.findUnique({
    where: { projectId_environmentId_appUserId_code: { projectId, environmentId, appUserId, code } },
  })
  if (!row || row.status !== 'active') return false
  return !row.endsAt || row.endsAt > new Date()
}

/** §202/§203 reconciliation: subscription state drives entitlement state. */
export async function reconcileEntitlements(projectId: string, environmentId: string) {
  const now = new Date()
  // 1. expire subscriptions past their period
  const expiredSubs = await db.subscription.updateMany({
    where: { projectId, environmentId, status: { in: ['active', 'trialing', 'past_due'] }, currentPeriodEnd: { lt: now } },
    data: { status: 'expired' },
  })
  const activeSubs = await db.subscription.findMany({
    where: { projectId, environmentId, status: { in: ['active', 'trialing'] } },
    include: { product: true },
  })
  let granted = 0
  for (const sub of activeSubs) {
    const code = sub.product.entitlementCode
    if (!code) continue
    const tierEntitlement = `${sub.productCode}${sub.tier ? `:${sub.tier}` : ''}`
    const res = await grantEntitlement({
      projectId, environmentId, appUserId: sub.appUserId, code,
      source: 'subscription', sourceRef: tierEntitlement,
      durationDays: Math.max(1, Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / 86400000)),
    })
    if (!res.renewed) granted++
  }
  // 2. entitlements sourced from subscriptions whose sub is no longer active → expire at period end
  const subEntitlements = await db.entitlement.findMany({
    where: { projectId, environmentId, source: 'subscription', status: 'active' },
  })
  let expiredEntitlements = 0
  for (const ent of subEntitlements) {
    const productCode = (ent.sourceRef ?? '').split(':')[0]
    const sub = productCode
      ? activeSubs.find((s) => s.appUserId === ent.appUserId && s.productCode === productCode)
      : undefined
    if (!sub) {
      // no active subscription backs this entitlement → expire if its end has passed
      if (!ent.endsAt || ent.endsAt < now) {
        await db.entitlement.update({ where: { id: ent.id }, data: { status: 'expired' } })
        expiredEntitlements++
      }
    }
  }
  return { expiredSubscriptions: expiredSubs.count, activeSubscriptions: activeSubs.length, granted, expiredEntitlements }
}

// ---------------------------------------------------------------------------
// Checkout (§41 provider abstraction + simulated provider)
// ---------------------------------------------------------------------------

interface ResolvedPrice {
  tier: string
  amount: number
  currency: string
  originalAmount?: number
  trialDays?: number
  offerCode?: string
  label?: string
}

export async function createCheckoutSession(params: {
  projectId: string
  environmentId: string
  appUserId: string
  productCode: string
  tier?: string
  offerCode?: string
}) {
  const product = await db.product.findUnique({
    where: { projectId_environmentId_code: { projectId: params.projectId, environmentId: params.environmentId, code: params.productCode } },
  })
  if (!product || product.status !== 'active') {
    throw new PlatformError({ code: 'PRODUCT_NOT_FOUND', category: 'not_found', message: `Product "${params.productCode}" not found or inactive.` })
  }

  const tiers = parseJson<Array<{ tier: string; amount: number; currency: string; trialDays?: number; entitlementCode?: string }>>(product.priceTiersJson, [])
  const offer = params.offerCode
    ? await db.offer.findUnique({
        where: { projectId_environmentId_code: { projectId: params.projectId, environmentId: params.environmentId, code: params.offerCode } },
      })
    : null
  if (params.offerCode && (!offer || offer.status !== 'active')) {
    throw new PlatformError({ code: 'OFFER_NOT_FOUND', category: 'not_found', message: `Offer "${params.offerCode}" not found or inactive.` })
  }

  // price resolution: offer pricing overrides product tier pricing (§45)
  const offerPricing = offer ? parseJson<Partial<ResolvedPrice> | null>(offer.pricingJson, null) : null
  const baseTier = tiers.find((t) => t.tier === (params.tier ?? offerPricing?.tier)) ?? tiers[0]
  if (!baseTier) {
    throw new PlatformError({ code: 'NO_PRICE_TIER', category: 'validation', message: 'Product has no price tiers configured.' })
  }
  const price: ResolvedPrice = {
    tier: baseTier.tier,
    amount: typeof offerPricing?.amount === 'number' ? offerPricing.amount : baseTier.amount,
    currency: offerPricing?.currency ?? baseTier.currency,
    originalAmount: typeof offerPricing?.originalAmount === 'number' ? offerPricing.originalAmount : undefined,
    trialDays: offerPricing?.trialDays ?? baseTier.trialDays,
    offerCode: offer?.code,
    label: offerPricing?.label,
  }

  const session = await db.checkoutSession.create({
    data: {
      projectId: params.projectId, environmentId: params.environmentId, appUserId: params.appUserId,
      offerCode: offer?.code ?? null, productCode: product.code, tier: price.tier,
      status: 'created', priceJson: JSON.stringify(price), provider: 'simulated',
      providerRef: `sim_${randomUUID().slice(0, 12)}`,
    },
  })
  return { session, price, product }
}

/** Complete a checkout with the simulated provider (success | failure).
 *  Exactly-once: only a `created` session can complete. */
export async function completeCheckoutSession(params: {
  projectId: string
  environmentId: string
  sessionId: string
  outcome?: 'success' | 'failure'
}) {
  const session = await db.checkoutSession.findUnique({ where: { id: params.sessionId } })
  if (!session || session.projectId !== params.projectId) {
    throw new PlatformError({ code: 'SESSION_NOT_FOUND', category: 'not_found', message: 'Checkout session not found.' })
  }
  if (session.status !== 'created') {
    throw new PlatformError({
      code: 'SESSION_ALREADY_RESOLVED', category: 'conflict',
      message: `Session already ${session.status} — completion is exactly-once (§201 payment safety).`,
    })
  }

  if (params.outcome === 'failure') {
    const failed = await db.checkoutSession.update({ where: { id: session.id }, data: { status: 'failed' } })
    return { status: 'failed', session: failed }
  }

  const product = await db.product.findUnique({
    where: { projectId_environmentId_code: { projectId: session.projectId, environmentId: session.environmentId, code: session.productCode } },
  })
  if (!product) {
    throw new PlatformError({ code: 'PRODUCT_NOT_FOUND', category: 'not_found', message: 'Product vanished mid-checkout.' })
  }
  const price = parseJson<ResolvedPrice>(session.priceJson, { tier: session.tier ?? 'default', amount: 0, currency: 'usd' })
  const entitlementCode = product.entitlementCode ?? null
  const results: Record<string, unknown> = {}

  if (product.type === 'subscription') {
    const trialDays = price.trialDays ?? 0
    const periodDays = trialDays > 0 ? trialDays : 30
    const sub = await db.subscription.upsert({
      where: { projectId_environmentId_appUserId_productCode: { projectId: session.projectId, environmentId: session.environmentId, appUserId: session.appUserId, productCode: product.code } },
      create: {
        projectId: session.projectId, environmentId: session.environmentId, appUserId: session.appUserId,
        productCode: product.code, tier: session.tier, status: trialDays > 0 ? 'trialing' : 'active',
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + periodDays * 86400000),
        trialEndsAt: trialDays > 0 ? new Date(Date.now() + trialDays * 86400000) : null,
        priceJson: JSON.stringify(price), provider: 'simulated', providerRef: session.providerRef,
      },
      update: {
        status: 'active', tier: session.tier, cancelAtPeriodEnd: false,
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
        priceJson: JSON.stringify(price), provider: 'simulated', providerRef: session.providerRef,
      },
    })
    results.subscription = { productCode: sub.productCode, tier: sub.tier, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd }

    if (entitlementCode) {
      const ent = await grantEntitlement({
        projectId: session.projectId, environmentId: session.environmentId, appUserId: session.appUserId,
        code: entitlementCode, source: 'subscription', sourceRef: product.code,
        durationDays: Math.ceil((sub.currentPeriodEnd.getTime() - Date.now()) / 86400000),
      })
      results.entitlement = { code: entitlementCode, status: ent.entitlement.status }
    }
  } else if (product.type === 'entitlement') {
    if (!entitlementCode) {
      throw new PlatformError({ code: 'MISSING_ENTITLEMENT_CODE', category: 'validation', message: 'Entitlement products must define entitlementCode.' })
    }
    const ent = await grantEntitlement({
      projectId: session.projectId, environmentId: session.environmentId, appUserId: session.appUserId,
      code: entitlementCode, source: 'purchase', sourceRef: session.id,
    })
    results.entitlement = { code: entitlementCode, status: ent.entitlement.status, permanent: !ent.entitlement.endsAt }
  } else if (product.type === 'consumable') {
    // consumable products grant virtual currency through the ledger (§204)
    const grant = parseJson<{ currency: string; amount: number }>(product.metadataJson, { currency: 'coins', amount: 0 })
    await postLedgerTransaction({
      projectId: session.projectId, environmentId: session.environmentId, appUserId: session.appUserId,
      currencyCode: grant.currency, amount: grant.amount, type: 'purchase', reason: `checkout:${session.id}`,
      idempotencyKey: `checkout-${session.id}`, reference: session.id,
    })
    results.currencyGrant = grant
  }

  const completed = await db.checkoutSession.update({
    where: { id: session.id },
    data: { status: 'completed', completedAt: new Date() },
  })
  return { status: 'completed', session: completed, ...results }
}

// ---------------------------------------------------------------------------
// Offers (§45) + Paywalls (§43/§44)
// ---------------------------------------------------------------------------

export async function getOffersForUser(projectId: string, environmentId: string, appUserId: string) {
  const context = await buildTargetingContext(projectId, environmentId, appUserId)
  const now = new Date()
  const offers = await db.offer.findMany({
    where: { projectId, environmentId, status: 'active' },
    orderBy: { priority: 'desc' },
  })
  return offers
    .filter((o) => (!o.startsAt || o.startsAt <= now) && (!o.endsAt || o.endsAt >= now))
    .filter((o) => matchesTargeting(o.targetingJson, context))
    .map((o) => ({
      code: o.code, name: o.name, description: o.description, productCode: o.productCode,
      pricing: parseJson<Record<string, unknown>>(o.pricingJson, {}),
      priority: o.priority,
    }))
}

export async function evaluatePaywall(params: { projectId: string; environmentId: string; appUserId: string; code: string }) {
  const paywall = await db.paywall.findUnique({
    where: { projectId_environmentId_code: { projectId: params.projectId, environmentId: params.environmentId, code: params.code } },
  })
  if (!paywall || paywall.status !== 'active') {
    throw new PlatformError({ code: 'PAYWALL_NOT_FOUND', category: 'not_found', message: `Paywall "${params.code}" not found or inactive.` })
  }
  const context = await buildTargetingContext(params.projectId, params.environmentId, params.appUserId)
  const entitled = await hasActiveEntitlement(params.projectId, params.environmentId, params.appUserId, paywall.entitlementCode)

  // wall applies when NOT entitled AND the wall's own targeting matches (§44)
  const applies = !entitled && matchesTargeting(paywall.targetingJson, context)

  const offerCodes = parseJson<string[]>(paywall.offersJson, [])
  const allOffers = await getOffersForUser(params.projectId, params.environmentId, params.appUserId)
  const wallOffers = offerCodes.length > 0 ? allOffers.filter((o) => offerCodes.includes(o.code)) : allOffers

  return {
    code: paywall.code,
    locked: applies,
    entitlement: paywall.entitlementCode,
    offers: applies ? wallOffers : [],
    config: parseJson<Record<string, unknown>>(paywall.configJson, {}),
    context: { user_level: (context.user as any)?.level, subscriptions: Object.keys((context.user as any)?.subscription ?? {}) },
  }
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export async function getUserSubscriptions(projectId: string, environmentId: string, appUserId: string) {
  const rows = await db.subscription.findMany({
    where: { projectId, environmentId, appUserId },
    orderBy: { createdAt: 'desc' },
    include: { product: { select: { name: true, type: true } } },
  })
  return rows.map((s) => ({
    productCode: s.productCode, productName: s.product.name, tier: s.tier, status: s.status,
    currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, trialEndsAt: s.trialEndsAt,
    price: parseJson<Record<string, unknown>>(s.priceJson, {}), provider: s.provider,
  }))
}

export async function cancelSubscription(projectId: string, environmentId: string, appUserId: string, productCode: string) {
  const sub = await db.subscription.findUnique({
    where: { projectId_environmentId_appUserId_productCode: { projectId, environmentId, appUserId, productCode } },
  })
  if (!sub) throw new PlatformError({ code: 'SUBSCRIPTION_NOT_FOUND', category: 'not_found', message: 'No subscription for this product.' })
  const updated = await db.subscription.update({
    where: { id: sub.id },
    data: { cancelAtPeriodEnd: true, status: sub.status === 'trialing' ? 'canceled' : 'active' },
  })
  return { productCode, cancelAtPeriodEnd: updated.cancelAtPeriodEnd, effectiveEnd: updated.currentPeriodEnd }
}

/** Signature helper for provider webhooks (§41 contract). */
export function signProviderPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function hashReference(ref: string): string {
  return createHash('sha256').update(ref).digest('hex').slice(0, 16)
}
