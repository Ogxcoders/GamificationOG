/**
 * GamificationOG — Formula Engine (Section 14)
 * Deterministic, sandboxed expression evaluation. No eval / new Function.
 * Grammar (precedence low -> high):
 *   expression := ternary
 *   ternary    := compare ("?" ternary ":" ternary)?
 *   compare    := additive (("=="|"!="|">"|"<"|">="|"<="|"and"|"or") additive)*
 *   additive   := multiplicative (("+"|"-") multiplicative)*
 *   multiplicative := unary (("*"|"/"|"%") unary)*
 *   unary      := ("-"|"not")? power
 *   power      := primary ("^" unary)?
 *   primary    := number | string | variable | function "(" args ")" | "(" expression ")"
 * Supported functions: min, max, floor, ceil, round, abs, clamp, sqrt, pow, if
 * Variables are namespaced: user.level, event.payload.count, ...
 */
import type { FormulaVariables } from '../core/types'

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
type TokenType = 'number' | 'string' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'question' | 'colon'
interface Token { type: TokenType; value: string }

const OPERATORS = ['==', '!=', '>=', '<=', '>', '<', '+', '-', '*', '/', '%', '^', '!', '=']

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '(') { tokens.push({ type: 'lparen', value: ch }); i++; continue }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ch }); i++; continue }
    if (ch === ',') { tokens.push({ type: 'comma', value: ch }); i++; continue }
    if (ch === '?') { tokens.push({ type: 'question', value: ch }); i++; continue }
    if (ch === ':') { tokens.push({ type: 'colon', value: ch }); i++; continue }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      let str = ''
      while (j < input.length && input[j] !== ch) {
        str += input[j]
        j++
      }
      if (j >= input.length) throw new FormulaError(`Unterminated string in formula`)
      tokens.push({ type: 'string', value: str })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i
      while (j < input.length && /[0-9.]/.test(input[j])) j++
      const num = input.slice(i, j)
      if ((num.match(/\./g) ?? []).length > 1) throw new FormulaError(`Invalid number "${num}"`)
      tokens.push({ type: 'number', value: num })
      i = j
      continue
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i
      while (j < input.length && /[a-zA-Z0-9_.]/.test(input[j])) j++
      tokens.push({ type: 'ident', value: input.slice(i, j) })
      i = j
      continue
    }
    const two = input.slice(i, i + 2)
    if (OPERATORS.includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue }
    if (OPERATORS.includes(ch)) { tokens.push({ type: 'op', value: ch }); i++; continue }
    throw new FormulaError(`Unexpected character "${ch}" at position ${i}`)
  }
  return tokens
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------
type Node =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; op: string; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'ternary'; cond: Node; then: Node; else: Node }
  | { kind: 'call'; name: string; args: Node[] }

export class FormulaError extends Error {
  constructor(message: string) {
    super(`FormulaError: ${message}`)
    this.name = 'FormulaError'
  }
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------
class Parser {
  private pos = 0
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined { return this.tokens[this.pos] }
  private next(): Token | undefined { return this.tokens[this.pos++] }
  private expect(type: TokenType, value?: string): Token {
    const t = this.next()
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      throw new FormulaError(`Expected ${value ?? type} but found ${t ? `'${t.value}'` : 'end of formula'}`)
    }
    return t
  }

  parse(): Node {
    if (this.tokens.length === 0) throw new FormulaError('Empty formula')
    const node = this.parseTernary()
    if (this.pos < this.tokens.length) {
      throw new FormulaError(`Unexpected token '${this.tokens[this.pos].value}' after expression`)
    }
    return node
  }

  private parseTernary(): Node {
    const cond = this.parseLogical()
    if (this.peek()?.type === 'question') {
      this.next()
      const then = this.parseTernary()
      this.expect('colon')
      const elseBranch = this.parseTernary()
      return { kind: 'ternary', cond, then, else: elseBranch }
    }
    return cond
  }

  private parseLogical(): Node {
    let left = this.parseComparison()
    while (this.peek()?.type === 'ident' && ['and', 'or', 'not'].includes(this.peek()!.value)) {
      const op = this.next()!.value
      if (op === 'not') {
        // unary not — bind tightly to the next comparison
        left = { kind: 'unary', op: 'not', operand: this.parseComparison() }
      } else {
        const right = this.parseComparison()
        left = { kind: 'binary', op, left, right }
      }
    }
    return left
  }

  private parseComparison(): Node {
    let left = this.parseAdditive()
    while (this.peek()?.type === 'op' && ['==', '!=', '>', '<', '>=', '<=', '='].includes(this.peek()!.value)) {
      const op = this.next()!.value === '=' ? '==' : this.next0(this.pos - 1)
      const right = this.parseAdditive()
      left = { kind: 'binary', op, left, right }
    }
    return left
  }

  private next0(pos: number): string { return this.tokens[pos].value }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative()
    while (this.peek()?.type === 'op' && ['+', '-'].includes(this.peek()!.value)) {
      const op = this.next()!.value
      const right = this.parseMultiplicative()
      left = { kind: 'binary', op, left, right }
    }
    return left
  }

  private parseMultiplicative(): Node {
    let left = this.parseUnary()
    while (this.peek()?.type === 'op' && ['*', '/', '%'].includes(this.peek()!.value)) {
      const op = this.next()!.value
      const right = this.parseUnary()
      left = { kind: 'binary', op, left, right }
    }
    return left
  }

  private parseUnary(): Node {
    const t = this.peek()
    if (t?.type === 'op' && t.value === '-') {
      this.next()
      return { kind: 'unary', op: '-', operand: this.parseUnary() }
    }
    return this.parsePower()
  }

  private parsePower(): Node {
    const base = this.parsePrimary()
    if (this.peek()?.type === 'op' && this.peek()!.value === '^') {
      this.next()
      const exponent = this.parseUnary()
      return { kind: 'binary', op: '^', left: base, right: exponent }
    }
    return base
  }

  private parsePrimary(): Node {
    const t = this.next()
    if (!t) throw new FormulaError('Unexpected end of formula')
    if (t.type === 'number') return { kind: 'number', value: parseFloat(t.value) }
    if (t.type === 'string') return { kind: 'string', value: t.value }
    if (t.type === 'lparen') {
      const inner = this.parseTernary()
      this.expect('rparen')
      return inner
    }
    if (t.type === 'ident') {
      if (this.peek()?.type === 'lparen') {
        this.next()
        const args: Node[] = []
        if (this.peek()?.type !== 'rparen') {
          args.push(this.parseTernary())
          while (this.peek()?.type === 'comma') {
            this.next()
            args.push(this.parseTernary())
          }
        }
        this.expect('rparen')
        return { kind: 'call', name: t.value, args }
      }
      if (['true', 'false'].includes(t.value)) return { kind: 'number', value: t.value === 'true' ? 1 : 0 }
      return { kind: 'variable', name: t.value }
    }
    throw new FormulaError(`Unexpected token '${t.value}'`)
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------
type Value = number | string | boolean

const FUNCTIONS: Record<string, (args: Value[]) => Value> = {
  min: (a) => Math.min(...a.map(toNum)),
  max: (a) => Math.max(...a.map(toNum)),
  floor: (a) => Math.floor(toNum(a[0])),
  ceil: (a) => Math.ceil(toNum(a[0])),
  round: (a) => {
    const n = toNum(a[0])
    const p = a.length > 1 ? toNum(a[1]) : 0
    const f = Math.pow(10, p)
    return Math.round(n * f) / f
  },
  abs: (a) => Math.abs(toNum(a[0])),
  sqrt: (a) => Math.sqrt(toNum(a[0])),
  pow: (a) => Math.pow(toNum(a[0]), toNum(a[1])),
  clamp: (a) => Math.min(Math.max(toNum(a[0]), toNum(a[1])), toNum(a[2])),
  if: (a) => (toBool(a[0]) ? a[1] : a[2]),
}

export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS)

function toNum(v: Value): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isNaN(n)) throw new FormulaError(`Cannot convert "${v}" to number`)
    return n
  }
  throw new FormulaError('Cannot convert value to number')
}

function toBool(v: Value): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v !== '' && v !== 'false' && v !== '0'
  return false
}

function resolveVariable(name: string, vars: FormulaVariables): Value {
  // 1. Flat lookup: variables may be keyed by full dot-path (flattened contexts)
  if (Object.prototype.hasOwnProperty.call(vars, name)) {
    const direct = (vars as Record<string, unknown>)[name]
    if (direct === null || direct === undefined) return 0
    if (typeof direct === 'number' || typeof direct === 'string' || typeof direct === 'boolean') return direct
    return 0
  }
  // 2. Nested walk: variables may be nested objects
  const parts = name.split('.')
  let current: unknown = vars
  for (const part of parts) {
    if (current === null || current === undefined) return 0
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part]
    } else {
      throw new FormulaError(`Cannot resolve property "${part}" of non-object in "${name}"`)
    }
  }
  if (current === null || current === undefined) return 0
  if (typeof current === 'number' || typeof current === 'string' || typeof current === 'boolean') return current
  if (typeof current === 'object') return 0
  return 0
}

function evaluate(node: Node, vars: FormulaVariables): Value {
  switch (node.kind) {
    case 'number': return node.value
    case 'string': return node.value
    case 'variable': return resolveVariable(node.name, vars)
    case 'unary': {
      if (node.op === '-') return -toNum(evaluate(node.operand, vars))
      if (node.op === 'not') return !toBool(evaluate(node.operand, vars))
      throw new FormulaError(`Unknown unary operator "${node.op}"`)
    }
    case 'binary': {
      const op = node.op
      if (op === 'and') return toBool(evaluate(node.left, vars)) && toBool(evaluate(node.right, vars))
      if (op === 'or') return toBool(evaluate(node.left, vars)) || toBool(evaluate(node.right, vars))
      const l = evaluate(node.left, vars)
      const r = evaluate(node.right, vars)
      switch (op) {
        case '+':
          if (typeof l === 'string' || typeof r === 'string') return `${l}${r}`
          return toNum(l) + toNum(r)
        case '-': return toNum(l) - toNum(r)
        case '*': return toNum(l) * toNum(r)
        case '/': {
          const d = toNum(r)
          if (d === 0) throw new FormulaError('Division by zero')
          return toNum(l) / d
        }
        case '%': {
          const d = toNum(r)
          if (d === 0) throw new FormulaError('Modulo by zero')
          return toNum(l) % d
        }
        case '^': return Math.pow(toNum(l), toNum(r))
        case '==': return l === r || toNumSafe(l) === toNumSafe(r)
        case '!=': return !(l === r || toNumSafe(l) === toNumSafe(r))
        case '>': return toNum(l) > toNum(r)
        case '<': return toNum(l) < toNum(r)
        case '>=': return toNum(l) >= toNum(r)
        case '<=': return toNum(l) <= toNum(r)
        default: throw new FormulaError(`Unknown operator "${op}"`)
      }
    }
    case 'ternary':
      return toBool(evaluate(node.cond, vars)) ? evaluate(node.then, vars) : evaluate(node.else, vars)
    case 'call': {
      const fn = FUNCTIONS[node.name]
      if (!fn) throw new FormulaError(`Unknown function "${node.name}". Available: ${FORMULA_FUNCTIONS.join(', ')}`)
      if (node.args.length > 64) throw new FormulaError('Too many function arguments')
      return fn(node.args.map((a) => evaluate(a, vars)))
    }
  }
}

function toNumSafe(v: Value): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  return Number.NaN
}

// ---------------------------------------------------------------------------
// Public API — deterministic evaluation with limits
// ---------------------------------------------------------------------------
const MAX_FORMULA_LENGTH = 512
const MAX_STEPS = 2000

const formulaCache = new Map<string, Node>()

export function evaluateFormula(expression: string, variables: FormulaVariables): number {
  const result = evaluateFormulaValue(expression, variables)
  return toNum(result)
}

export function evaluateFormulaValue(expression: string, variables: FormulaVariables): Value {
  if (expression.length > MAX_FORMULA_LENGTH) {
    throw new FormulaError(`Formula exceeds maximum length of ${MAX_FORMULA_LENGTH} characters`)
  }
  let ast = formulaCache.get(expression)
  if (!ast) {
    const tokens = tokenize(expression)
    ast = new Parser(tokens).parse()
    if (formulaCache.size < 500) formulaCache.set(expression, ast)
  }
  return evaluateWithBudget(ast, variables)
}

let stepBudget = 0
function evaluateWithBudget(ast: Node, vars: FormulaVariables): Value {
  stepBudget = MAX_STEPS
  try {
    return evaluateCounted(ast, vars)
  } finally {
    stepBudget = 0
  }
}

function evaluateCounted(node: Node, vars: FormulaVariables): Value {
  if (--stepBudget < 0) throw new FormulaError('Formula evaluation exceeded step budget')
  switch (node.kind) {
    case 'binary': {
      // short-circuit logical ops without evaluating both sides twice
      if (node.op === 'and') {
        if (!toBool(evaluateCounted(node.left, vars))) return false
        return toBool(evaluateCounted(node.right, vars))
      }
      if (node.op === 'or') {
        if (toBool(evaluateCounted(node.left, vars))) return true
        return toBool(evaluateCounted(node.right, vars))
      }
      const l = evaluateCounted(node.left, vars)
      const r = evaluateCounted(node.right, vars)
      return applyBinary(node.op, l, r)
    }
    default:
      return evaluate(node, vars)
  }
}

function applyBinary(op: string, l: Value, r: Value): Value {
  switch (op) {
    case '+':
      if (typeof l === 'string' || typeof r === 'string') return `${l}${r}`
      return toNum(l) + toNum(r)
    case '-': return toNum(l) - toNum(r)
    case '*': return toNum(l) * toNum(r)
    case '/': {
      const d = toNum(r)
      if (d === 0) throw new FormulaError('Division by zero')
      return toNum(l) / d
    }
    case '%': {
      const d = toNum(r)
      if (d === 0) throw new FormulaError('Modulo by zero')
      return toNum(l) % d
    }
    case '^': return Math.pow(toNum(l), toNum(r))
    case '==': return l === r || toNumSafe(l) === toNumSafe(r)
    case '!=': return !(l === r || toNumSafe(l) === toNumSafe(r))
    case '>': return toNum(l) > toNum(r)
    case '<': return toNum(l) < toNum(r)
    case '>=': return toNum(l) >= toNum(r)
    case '<=': return toNum(l) <= toNum(r)
    default: throw new FormulaError(`Unknown operator "${op}"`)
  }
}

export function validateFormula(expression: string): { valid: boolean; error?: string } {
  try {
    const tokens = tokenize(expression)
    new Parser(tokens).parse()
    return { valid: true }
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : 'Invalid formula' }
  }
}
