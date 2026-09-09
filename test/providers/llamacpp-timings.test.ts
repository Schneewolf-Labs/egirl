import { describe, expect, test } from 'bun:test'
import { formatTimings } from '../../src/providers/llamacpp'

describe('formatTimings', () => {
  test('reports prefilled and cached token counts with rates', () => {
    const line = formatTimings({
      prompt_n: 120,
      cache_n: 58000,
      prompt_ms: 240,
      predicted_n: 300,
      predicted_ms: 12000,
    })
    expect(line).toBe(
      'timings: prompt_n=120 cache_n=58000 prompt_ms=240 (500 tok/s) predicted_n=300 (25.0 tok/s)',
    )
  })

  test('omits fields the server did not send and never divides by zero', () => {
    expect(formatTimings({ prompt_n: 0, prompt_ms: 0 })).toBe('timings: prompt_n=0 prompt_ms=0')
    expect(formatTimings({})).toBe('timings: ')
  })
})
