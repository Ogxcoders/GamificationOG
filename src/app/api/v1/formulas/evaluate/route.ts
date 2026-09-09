/**
 * POST /api/v1/formulas/evaluate — Safe formula evaluation for SDKs and
 * AI agents (MCP control plane, Sections 65, 154: rule.test).
 *
 * API-key authenticated, scope: "formulas:eval". Evaluates an expression
 * through the platform's sandboxed deterministic formula engine (the same
 * engine that powers rule rewards) — never eval, no side effects, no
 * database access. Agents use this to dry-run reward formulas before
 * proposing configuration changes.
 */
import { NextRequest } from 'next/server'
import { json, apiError, readJson, requireApiKey, requireScope, requireStringField } from '@/lib/api'
import { evaluateFormula } from '@/server/engine/formula'
import { PlatformError } from '@/server/core/errors'

interface FormulaEvalRequest {
  expr: string
  vars?: Record<string, string | number | boolean>
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiKey(req)
    requireScope(auth, 'formulas:eval')
    const body = await readJson<FormulaEvalRequest>(req)
    const expr = requireStringField(body as unknown as Record<string, unknown>, 'expr')

    const vars = body.vars && typeof body.vars === 'object' ? body.vars : {}
    const started = performance.now()
    try {
      const value = evaluateFormula(expr, vars)
      return json({
        expr,
        value,
        evaluatedInMs: Number((performance.now() - started).toFixed(3)),
        engine: 'deterministic-sandboxed-v1',
      })
    } catch (e) {
      // formula errors are structured validation feedback, not 500s
      throw new PlatformError({
        code: 'FORMULA_INVALID',
        category: 'validation',
        message: e instanceof Error ? e.message : 'Formula failed to evaluate.',
        fix: 'Check syntax, variable names, and function arguments (allowed: min, max, floor, ceil, round, abs, clamp, sqrt, pow, if).',
      })
    }
  } catch (e) {
    return apiError(e)
  }
}
