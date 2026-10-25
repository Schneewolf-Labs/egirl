import type { Tool, ToolResult } from '../types'
import { evaluateDateStatement, isDateStatement } from './calculate-dates'
import { CalcError, evaluateStatement, formatNumber } from './calculate-parser'

const MAX_INPUT = 500
const DECLARATION = /^(?:let|const|var)\s+(?=[A-Za-z_]\w*\s*=)/
const PROGRAM =
  /^(?:import\s|from\s+\S+\s+import\s|def\s|class\s|for\s*[(\w]|while\s*[(\w]|print\s*\(|return\b)/

/**
 * Exact arithmetic without a shell. A small model doing multi-step percentages or unit math in
 * its head gets it wrong often enough to matter, and an instance serving strangers has
 * `execute_command` off, so this is its only way to compute.
 */
export const calculateTool: Tool = {
  definition: {
    name: 'calculate',
    description:
      'Evaluate arithmetic exactly. Use it for any calculation beyond trivial mental math ' +
      '(percentages, compound growth, unit conversions, multi-step sums) instead of computing in ' +
      'your head, then answer from the result. Operators: + - * / % (modulo) ^ or ** (power), ' +
      'parentheses. Functions: sqrt abs round(x, digits) floor ceil min max log (natural) log10 ' +
      'log2 exp sin cos tan (radians). Constants: pi, e. Write percentages as decimals ' +
      '("15% of 80" is 0.15 * 80). Several statements may be separated by newlines or ";", and ' +
      '"name = expr" stores a value for later statements, e.g. "rate = 0.05; 1000 * (1 + rate)^10". ' +
      'Dates (use these instead of counting days by hand; "today" works as a date): ' +
      'days_between("2026-03-03", "2026-10-20"), add_days("2026-01-01", 90), ' +
      'weekday("1776-07-04"), today(). Dates are YYYY-MM-DD, computed in UTC.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The expression(s) to evaluate, e.g. "(1200 - 950) / 950 * 100"',
        },
      },
      required: ['expression'],
    },
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const input = typeof params.expression === 'string' ? params.expression.trim() : ''
    if (!input) return { success: false, output: 'expression is required' }
    if (input.length > MAX_INPUT) {
      return { success: false, output: `expression is too long (max ${MAX_INPUT} characters)` }
    }

    const statements = input
      .split(/[;\n]/)
      // Models write `let x = 1` from habit; the keyword adds nothing to an assignment
      .map((s) => s.trim().replace(DECLARATION, ''))
      .filter(Boolean)
    const code = statements.find((s) => PROGRAM.test(s))
    if (code) {
      return {
        success: false,
        output:
          `"${code}" is program code; calculate only evaluates arithmetic. Use run_code for ` +
          'programs if you have it, or rewrite this as plain expressions.',
      }
    }
    const vars = new Map<string, number>()
    const lines: string[] = []
    for (const statement of statements) {
      try {
        const result = isDateStatement(statement)
          ? evaluateDateStatement(statement)
          : formatNumber(evaluateStatement(statement, vars))
        lines.push(`${statement} → ${result}`)
      } catch (error) {
        if (!(error instanceof CalcError)) throw error
        const where = statements.length > 1 ? ` in "${statement}"` : ''
        return { success: false, output: `Error${where}: ${error.message}` }
      }
    }
    return { success: true, output: lines.join('\n') }
  },
}
