import type { Tool, ToolResult } from '../types'
import { CalcError, evaluateStatement, formatNumber } from './calculate-parser'

const MAX_INPUT = 500

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
      '"name = expr" stores a value for later statements, e.g. "rate = 0.05; 1000 * (1 + rate)^10".',
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
      .map((s) => s.trim())
      .filter(Boolean)
    const vars = new Map<string, number>()
    const lines: string[] = []
    for (const statement of statements) {
      try {
        lines.push(`${statement} → ${formatNumber(evaluateStatement(statement, vars))}`)
      } catch (error) {
        if (!(error instanceof CalcError)) throw error
        const where = statements.length > 1 ? ` in "${statement}"` : ''
        return { success: false, output: `Error${where}: ${error.message}` }
      }
    }
    return { success: true, output: lines.join('\n') }
  },
}
