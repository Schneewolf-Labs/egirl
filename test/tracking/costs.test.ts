import { describe, expect, test } from 'bun:test'
import { calculateCost, formatCost, MODEL_COSTS } from '../../src/tracking/costs'

describe('MODEL_COSTS', () => {
  test('has entries for known models', () => {
    expect(MODEL_COSTS['gpt-4o']).toBeDefined()
    expect(MODEL_COSTS['claude-sonnet-4-20250514']).toBeDefined()
    expect(MODEL_COSTS.local).toBeDefined()
  })

  test('local model is free', () => {
    expect(MODEL_COSTS.local.input).toBe(0)
    expect(MODEL_COSTS.local.output).toBe(0)
  })
})

describe('calculateCost', () => {
  test('calculates cost for known model', () => {
    // gpt-4o: input $2.5/M, output $10.0/M
    const cost = calculateCost('gpt-4o', 1_000_000, 1_000_000)
    expect(cost).toBe(12.5)
  })

  test('calculates cost with partial tokens', () => {
    // gpt-4o: input $2.5/M
    const cost = calculateCost('gpt-4o', 500_000, 0)
    expect(cost).toBe(1.25)
  })

  test('returns zero for local model', () => {
    expect(calculateCost('local', 1000, 1000)).toBe(0)
  })

  test('falls back to local cost for unknown model', () => {
    expect(calculateCost('unknown-model-xyz', 1000, 1000)).toBe(0)
  })

  test('calculates anthropic model costs', () => {
    // claude-sonnet-4: input $3.0/M, output $15.0/M
    const cost = calculateCost('claude-sonnet-4-20250514', 100_000, 50_000)
    // input: 100000/1M * 3.0 = 0.3
    // output: 50000/1M * 15.0 = 0.75
    expect(cost).toBeCloseTo(1.05, 4)
  })
})

describe('formatCost', () => {
  test('formats zero cost', () => {
    expect(formatCost(0)).toBe('$0.00')
  })

  test('formats very small cost', () => {
    expect(formatCost(0.0001)).toBe('<$0.001')
  })

  test('formats normal cost', () => {
    expect(formatCost(1.2345)).toBe('$1.2345')
  })

  test('formats cost with 4 decimal places', () => {
    expect(formatCost(0.05)).toBe('$0.0500')
  })
})
