/**
 * GamificationOG — Economy Service (Section 27)
 * Wallet -> Ledger Transaction -> Balance Projection.
 * The ledger is the immutable source of truth; WalletBalance is a
 * rebuildable projection. Every mutation records source/reason/reference,
 * correlation + causation ids, and is idempotent via unique idempotency keys.
 * Economy accounting rule (Section 204): sum(ledger) == sum(projections).
 */
import { db } from '@/lib/db'
import { parseJson } from '../core/types'
import { PlatformError } from '../core/errors'

export interface LedgerEntryInput {
  projectId: string
  environmentId: string
  appUserId: string
  currencyCode: string
  amount: number // signed
  type: string // earn | spend | transfer | refund | adjustment | grant | reversal
  reason?: string
  source?: string
  reference?: string
  correlationId?: string
  causationId?: string
  idempotencyKey?: string
  actorType?: string
  actorId?: string
  metadata?: Record<string, unknown>
}

export interface LedgerResult {
  status: 'posted' | 'duplicate'
  transactionId: string
  balanceAfter: number
  currencyCode: string
}

export async function getOrCreateCurrency(projectId: string, environmentId: string, code: string) {
  const currency = await db.currency.findUnique({
    where: { projectId_environmentId_code: { projectId, environmentId, code } },
  })
  if (!currency) {
    throw new PlatformError({
      code: 'CURRENCY_NOT_FOUND',
      category: 'economy',
      message: `Currency "${code}" does not exist in this environment.`,
      fix: `Add currency "${code}" in Economy settings or change the reward/rule configuration.`,
    })
  }
  return currency
}

export async function getWalletBalance(appUserId: string, currencyId: string): Promise<number> {
  const wallet = await db.walletBalance.findUnique({
    where: { appUserId_currencyId: { appUserId, currencyId } },
  })
  return wallet ? wallet.balance : 0
}

export async function getWalletBalances(appUserId: string) {
  const wallets = await db.walletBalance.findMany({
    where: { appUserId },
    include: { currency: true },
  })
  return wallets.map((w) => ({
    currency: w.currency.code,
    currencyName: w.currency.name,
    currencyType: w.currency.type,
    balance: w.balance,
    locked: w.lockedBalance,
  }))
}

/**
 * Post a signed ledger transaction and update the wallet projection
 * atomically. Idempotent: same (project, env, idempotencyKey) returns
 * the original result instead of double-posting (Invariant E).
 */
export async function postLedgerTransaction(input: LedgerEntryInput): Promise<LedgerResult> {
  const { projectId, environmentId, appUserId, currencyCode, amount } = input

  if (!Number.isFinite(amount) || amount === 0) {
    throw new PlatformError({
      code: 'INVALID_AMOUNT',
      category: 'economy',
      message: `Ledger amount must be a non-zero finite number (got ${amount}).`,
    })
  }

  const currency = await getOrCreateCurrency(projectId, environmentId, currencyCode)
  const capConfig = parseJson<{ maxBalance?: number }>(currency.capConfigJson, {})

  // Idempotency check
  if (input.idempotencyKey) {
    const existing = await db.ledgerTransaction.findUnique({
      where: {
        projectId_environmentId_idempotencyKey: {
          projectId,
          environmentId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    })
    if (existing) {
      return {
        status: 'duplicate',
        transactionId: existing.id,
        balanceAfter: existing.balanceAfter,
        currencyCode,
      }
    }
  }

  const currentBalance = await getWalletBalance(appUserId, currency.id)
  const balanceAfter = currentBalance + amount

  if (balanceAfter < 0) {
    throw new PlatformError({
      code: 'INSUFFICIENT_FUNDS',
      category: 'economy',
      message: `Insufficient balance for ${currencyCode}: current ${currentBalance}, attempted change ${amount}.`,
      fix: 'Grant more currency first, lower the price, or configure a negative-balance policy.',
    })
  }

  if (capConfig.maxBalance && balanceAfter > capConfig.maxBalance) {
    throw new PlatformError({
      code: 'BALANCE_CAP_EXCEEDED',
      category: 'economy',
      message: `Balance cap exceeded for ${currencyCode}: would reach ${balanceAfter} (cap ${capConfig.maxBalance}).`,
      fix: 'Raise the currency cap or reduce the awarded amount.',
    })
  }

  // Atomic: ledger insert + wallet upsert in one transaction
  const result = await db.$transaction(async (tx) => {
    const transaction = await tx.ledgerTransaction.create({
      data: {
        projectId,
        environmentId,
        appUserId,
        currencyId: currency.id,
        amount,
        type: input.type,
        reason: input.reason,
        source: input.source ?? 'rule',
        reference: input.reference,
        correlationId: input.correlationId,
        causationId: input.causationId,
        idempotencyKey: input.idempotencyKey,
        balanceAfter,
        actorType: input.actorType ?? 'system',
        actorId: input.actorId,
        metadataJson: JSON.stringify(input.metadata ?? {}),
      },
    })

    await tx.walletBalance.upsert({
      where: { appUserId_currencyId: { appUserId, currencyId: currency.id } },
      create: {
        appUserId,
        currencyId: currency.id,
        balance: balanceAfter,
      },
      update: { balance: balanceAfter },
    })

    return transaction
  })

  return {
    status: 'posted',
    transactionId: result.id,
    balanceAfter,
    currencyCode,
  }
}

/** Rebuild wallet projections from the ledger (Section 173 — projections are rebuildable). */
export async function rebuildWalletProjection(projectId: string, environmentId: string): Promise<{ rebuilt: number }> {
  const entries = await db.ledgerTransaction.findMany({
    where: { projectId, environmentId },
    orderBy: { createdAt: 'asc' },
    include: { currency: true },
  })

  const balances = new Map<string, { appUserId: string; currencyId: string; balance: number }>()
  for (const e of entries) {
    const key = `${e.appUserId}:${e.currencyId}`
    const current = balances.get(key) ?? { appUserId: e.appUserId, currencyId: e.currencyId, balance: 0 }
    current.balance += e.amount
    balances.set(key, current)
  }

  await db.$transaction(
    Array.from(balances.values()).map((b) =>
      db.walletBalance.upsert({
        where: { appUserId_currencyId: { appUserId: b.appUserId, currencyId: b.currencyId } },
        create: { appUserId: b.appUserId, currencyId: b.currencyId, balance: b.balance },
        update: { balance: b.balance },
      }),
    ),
  )

  return { rebuilt: balances.size }
}

/** Economy accounting integrity check: ledger sum vs projection sum. */
export async function verifyEconomyIntegrity(projectId: string, environmentId: string) {
  const currencies = await db.currency.findMany({ where: { projectId, environmentId } })
  const results: Array<{ currency: string; ledgerSum: number; projectionSum: number; consistent: boolean }> = []

  for (const c of currencies) {
    const agg = await db.ledgerTransaction.aggregate({
      where: { currencyId: c.id },
      _sum: { amount: true },
    })
    const walletAgg = await db.walletBalance.aggregate({
      where: { currencyId: c.id },
      _sum: { balance: true },
    })
    const ledgerSum = agg._sum.amount ?? 0
    const projectionSum = walletAgg._sum.balance ?? 0
    results.push({
      currency: c.code,
      ledgerSum,
      projectionSum,
      consistent: Math.abs(ledgerSum - projectionSum) < 0.00001,
    })
  }

  return results
}

export async function getLedgerHistory(options: {
  projectId: string
  environmentId: string
  appUserId?: string
  currencyCode?: string
  limit?: number
}) {
  const where: Record<string, unknown> = { projectId: options.projectId, environmentId: options.environmentId }
  if (options.appUserId) where.appUserId = options.appUserId
  if (options.currencyCode) {
    const currency = await db.currency.findUnique({
      where: { projectId_environmentId_code: { projectId: options.projectId, environmentId: options.environmentId, code: options.currencyCode } },
    })
    where.currencyId = currency?.id ?? '__none__'
  }
  return db.ledgerTransaction.findMany({
    where: where as never,
    orderBy: { createdAt: 'desc' },
    take: options.limit ?? 50,
    include: {
      currency: { select: { code: true, name: true } },
      appUser: { select: { externalId: true, displayName: true } },
    },
  })
}
