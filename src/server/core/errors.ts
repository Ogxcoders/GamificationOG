/**
 * GamificationOG — Structured Error Model (Section 106: Error Experience)
 * Errors are human-readable, actionable, structured, traceable.
 */
import { randomUUID } from 'crypto'

export type ErrorCategory =
  | 'validation' | 'auth' | 'not_found' | 'conflict' | 'rate_limit'
  | 'idempotency' | 'engine' | 'economy' | 'internal'

export class PlatformError extends Error {
  code: string
  category: ErrorCategory
  status: number
  detail?: string
  fix?: string
  traceId: string
  /** Optional response headers (e.g. Retry-After on rate-limit errors). */
  headers?: Record<string, string>

  constructor(params: {
    code: string
    category: ErrorCategory
    message: string
    status?: number
    detail?: string
    fix?: string
    traceId?: string
    headers?: Record<string, string>
  }) {
    super(params.message)
    this.name = 'PlatformError'
    this.code = params.code
    this.category = params.category
    this.status = params.status ?? statusForCategory(params.category)
    this.detail = params.detail
    this.fix = params.fix
    this.traceId = params.traceId ?? newTraceId()
    this.headers = params.headers
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        category: this.category,
        message: this.message,
        detail: this.detail,
        fix: this.fix,
        trace_id: this.traceId,
      },
    }
  }
}

function statusForCategory(category: ErrorCategory): number {
  switch (category) {
    case 'validation': return 400
    case 'auth': return 401
    case 'not_found': return 404
    case 'conflict': return 409
    case 'rate_limit': return 429
    case 'idempotency': return 200 // replayed result
    case 'engine': return 422
    case 'economy': return 422
    case 'internal': return 500
  }
}

export function newTraceId(): string {
  return randomUUID()
}

export function isPlatformError(e: unknown): e is PlatformError {
  return e instanceof PlatformError
}

export function toErrorPayload(e: unknown) {
  if (isPlatformError(e)) return e.toJSON()
  return {
    error: {
      code: 'INTERNAL_ERROR',
      category: 'internal' as ErrorCategory,
      message: e instanceof Error ? e.message : 'Unexpected internal error',
      trace_id: newTraceId(),
    },
  }
}
