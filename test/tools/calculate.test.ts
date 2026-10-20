import { describe, expect, test } from 'bun:test'
import { calculateTool } from '../../src/tools/builtin/calculate'

async function calc(expression: unknown) {
  return calculateTool.execute({ expression }, '/tmp')
}

async function value(expression: string): Promise<string> {
  const r = await calc(expression)
  expect(r.success).toBe(true)
  return r.output.split(' → ').pop() as string
}

async function error(expression: unknown): Promise<string> {
  const r = await calc(expression)
  expect(r.success).toBe(false)
  return r.output
}

describe('calculate', () => {
  test('operator precedence and parentheses', async () => {
    expect(await value('2 + 3 * 4')).toBe('14')
    expect(await value('(2 + 3) * 4')).toBe('20')
    expect(await value('10 - 4 - 3')).toBe('3')
    expect(await value('100 / 10 / 5')).toBe('2')
    expect(await value('17 % 5')).toBe('2')
  })

  test('power is right-associative and binds tighter than unary minus', async () => {
    expect(await value('2 ^ 3 ^ 2')).toBe('512')
    expect(await value('2 ** 10')).toBe('1024')
    expect(await value('-2 ^ 2')).toBe('-4')
    expect(await value('(-2) ^ 2')).toBe('4')
    expect(await value('2 ^ -1')).toBe('0.5')
    expect(await value('--3')).toBe('3')
  })

  test('numbers: decimals and scientific notation', async () => {
    expect(await value('.5 + 1.25')).toBe('1.75')
    expect(await value('1.5e3 * 2')).toBe('3000')
    expect(await value('2E-3 * 1000')).toBe('2')
  })

  test('functions and constants', async () => {
    expect(await value('sqrt(144)')).toBe('12')
    expect(await value('abs(-7.5)')).toBe('7.5')
    expect(await value('round(2.71828, 2)')).toBe('2.72')
    expect(await value('round(2.5)')).toBe('3')
    expect(await value('floor(-1.5) + ceil(1.2)')).toBe('0')
    expect(await value('min(4, 2, 8) + max(1, 9)')).toBe('11')
    expect(await value('log(e)')).toBe('1')
    expect(await value('log10(1000) + log2(8)')).toBe('6')
    expect(await value('exp(0)')).toBe('1')
    expect(await value('sin(pi / 2)')).toBe('1')
    expect(await value('cos(0) + tan(0)')).toBe('1')
  })

  test('float artefacts are hidden', async () => {
    expect(await value('0.1 + 0.2')).toBe('0.3')
    expect(await value('1 / 3')).toBe('0.333333333333')
  })

  test('statements and variables', async () => {
    const r = await calc('rate = 0.05; 1000 * (1 + rate)^10')
    expect(r.success).toBe(true)
    expect(r.output).toBe('rate = 0.05 → 0.05\n1000 * (1 + rate)^10 → 1628.89462678')
    expect(await value('a = 3\nb = 4\nsqrt(a^2 + b^2)')).toBe('5')
  })

  test('percent-style questions written as decimals', async () => {
    expect(await value('0.15 * 80')).toBe('12')
    expect(await value('(1200 - 950) / 950 * 100')).toBe('26.3157894737')
  })

  test('errors are reported, not thrown', async () => {
    expect(await error('1 / 0')).toContain('division by zero')
    expect(await error('5 % 0')).toContain('modulo by zero')
    expect(await error('sqrt(-1)')).toContain('not a real number')
    expect(await error('10 ^ 400')).toContain('overflow')
    expect(await error('2 +')).toContain('end of input')
    expect(await error('(1 + 2')).toContain("expected ')'")
    expect(await error('1 2')).toContain('position 3')
    expect(await error('2 $ 3')).toContain("unexpected character '$' at position 3")
    expect(await error('foo + 1')).toContain("unknown name 'foo'")
    expect(await error('sqrt + 1')).toContain('sqrt is a function')
    expect(await error('round(1, 2, 3)')).toContain('takes 1 to 2 argument(s)')
    expect(await error('pi = 3')).toContain("cannot assign to 'pi'")
    expect(await error('x = 1; y + 1')).toContain('in "y + 1"')
    expect(await error('')).toContain('required')
    expect(await error(42)).toContain('required')
    expect(await error('1+'.repeat(300))).toContain('too long')
    expect(await error(`${'('.repeat(100)}1${')'.repeat(100)}`)).toContain('nested too deeply')
  })

  test('JavaScript is not reachable', async () => {
    for (const attempt of [
      'process.exit()',
      'constructor',
      '__proto__',
      'toString()',
      'Math.PI',
      'eval("1")',
      'globalThis',
      'this',
      'hasOwnProperty',
      'valueOf()',
    ]) {
      const r = await calc(attempt)
      expect(r.success).toBe(false)
    }
    // Prototype names are ordinary variable names: assignable, never resolved to JavaScript
    expect(await value('constructor = 1; constructor + 1')).toBe('2')
  })
  test('a trailing percent sign explains itself instead of a bare syntax error', async () => {
    expect(await error('15%')).toContain('write percentages as decimals')
    expect(await error('80 * 15%')).toContain('write percentages as decimals')
    expect(await error('(15%) * 80')).toContain('write percentages as decimals')
    expect(await value('17 % 5')).toBe('2')
    expect(await value('17 % (2 + 3)')).toBe('2')
  })

  test('round goes half away from zero', async () => {
    expect(await value('round(2.5)')).toBe('3')
    expect(await value('round(-2.5)')).toBe('-3')
    expect(await value('round(-1.25, 1)')).toBe('-1.3')
  })
})
