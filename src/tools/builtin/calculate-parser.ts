/**
 * Arithmetic for the calculate tool: a tokenizer and a recursive-descent evaluator. No eval, no
 * Function: identifiers resolve only through the Maps below, so nothing a caller writes can reach
 * a JavaScript object (`constructor`, `process`, `__proto__` are just unknown names).
 *
 *   statement := name '=' expr | expr
 *   expr      := term (('+' | '-') term)*
 *   term      := unary (('*' | '/' | '%') unary)*
 *   unary     := ('-' | '+') unary | power
 *   power     := primary (('^' | '**') unary)?      right-associative; -2^2 = -4
 *   primary   := number | name | name '(' expr (',' expr)* ')' | '(' expr ')'
 */

import { CONSTANTS, FUNCTIONS } from './calculate-functions'

const MAX_DEPTH = 64

interface Token {
  kind: 'num' | 'name' | 'op'
  text: string
  value?: number
  pos: number
}

const NUMBER = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/
const OPS = ['**', '+', '-', '*', '/', '%', '^', '(', ')', ',', '=']

export class CalcError extends Error {}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i] as string
    if (/\s/.test(ch)) {
      i++
      continue
    }
    const rest = src.slice(i)
    const num = NUMBER.exec(rest)
    if (num) {
      tokens.push({ kind: 'num', text: num[0], value: Number(num[0]), pos: i })
      i += num[0].length
      continue
    }
    const name = NAME.exec(rest)
    if (name) {
      tokens.push({ kind: 'name', text: name[0], pos: i })
      i += name[0].length
      continue
    }
    const op = OPS.find((o) => rest.startsWith(o))
    if (!op) throw new CalcError(`unexpected character '${ch}' at position ${i + 1}`)
    tokens.push({ kind: 'op', text: op, pos: i })
    i += op.length
  }
  return tokens
}

/** Evaluate one statement. Assignments store into `vars` and return the assigned value. */
export function evaluateStatement(src: string, vars: Map<string, number>): number {
  const tokens = tokenize(src)
  let i = 0
  let depth = 0

  const peek = (): Token | undefined => tokens[i]
  const at = (t: Token | undefined): string => (t ? `position ${t.pos + 1}` : 'end of input')
  const isOp = (text: string): boolean => peek()?.kind === 'op' && peek()?.text === text
  const expect = (text: string): void => {
    if (!isOp(text)) throw new CalcError(`expected '${text}' at ${at(peek())}`)
    i++
  }
  const nest = <T>(f: () => T): T => {
    if (++depth > MAX_DEPTH) throw new CalcError('expression is nested too deeply')
    try {
      return f()
    } finally {
      depth--
    }
  }

  // What can begin an operand. A '%' followed by anything else is a percent sign, not modulo
  const startsOperand = (t: Token | undefined): boolean =>
    t !== undefined && (t.kind !== 'op' || ['(', '-', '+'].includes(t.text))

  const expr = (): number =>
    nest(() => {
      let v = term()
      while (isOp('+') || isOp('-')) v = tokens[i++]?.text === '+' ? v + term() : v - term()
      return v
    })

  const term = (): number => {
    let v = unaryExpr()
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[i++]?.text
      if (op === '%' && !startsOperand(peek())) {
        throw new CalcError(
          "'%' is modulo, not percent: write percentages as decimals (15% of 80 is 0.15 * 80)",
        )
      }
      const r = unaryExpr()
      if (op === '*') v *= r
      else if (r === 0) throw new CalcError(op === '/' ? 'division by zero' : 'modulo by zero')
      else v = op === '/' ? v / r : v % r
    }
    return v
  }

  const unaryExpr = (): number =>
    nest(() => {
      if (!isOp('-') && !isOp('+')) return power()
      const negate = tokens[i++]?.text === '-'
      const v = unaryExpr()
      return negate ? -v : v
    })

  const power = (): number => {
    const base = primary()
    if (!isOp('^') && !isOp('**')) return base
    i++
    return base ** unaryExpr()
  }

  const primary = (): number => {
    const t = peek()
    if (!t) throw new CalcError('unexpected end of input')
    i++
    if (t.kind === 'num') return t.value as number
    if (t.kind === 'op' && t.text === '(') {
      const v = expr()
      expect(')')
      return v
    }
    if (t.kind !== 'name') throw new CalcError(`unexpected '${t.text}' at ${at(t)}`)
    const fn = FUNCTIONS.get(t.text)
    if (fn && isOp('(')) {
      i++
      const args = [expr()]
      while (isOp(',')) {
        i++
        args.push(expr())
      }
      expect(')')
      const [lo, hi] = fn.arity
      if (args.length < lo || args.length > hi) {
        throw new CalcError(
          `${t.text}() takes ${lo === hi ? lo : `${lo} to ${hi}`} argument(s), got ${args.length}`,
        )
      }
      return fn.apply(args)
    }
    const v = vars.get(t.text) ?? CONSTANTS.get(t.text)
    if (v !== undefined) return v
    throw new CalcError(
      fn ? `${t.text} is a function: write ${t.text}(...)` : `unknown name '${t.text}'`,
    )
  }

  let target: string | undefined
  if (tokens[0]?.kind === 'name' && tokens[1]?.kind === 'op' && tokens[1].text === '=') {
    target = tokens[0].text
    if (CONSTANTS.has(target) || FUNCTIONS.has(target))
      throw new CalcError(`cannot assign to '${target}'`)
    i = 2
  }
  if (tokens.length === i) throw new CalcError('empty expression')
  const value = expr()
  if (i < tokens.length) throw new CalcError(`unexpected '${tokens[i]?.text}' at ${at(tokens[i])}`)
  if (Number.isNaN(value)) throw new CalcError('result is not a real number')
  if (!Number.isFinite(value)) throw new CalcError('result is too large (overflow)')
  if (target) vars.set(target, value)
  return value
}

/** 12 significant digits, trailing zeros dropped: 0.1 + 0.2 reads 0.3. */
export function formatNumber(n: number): string {
  if (Object.is(n, -0)) return '0'
  return String(Number(n.toPrecision(12)))
}
