import { describe, expect, test } from 'bun:test'
import { KeyPool } from '../../src/providers/key-pool'

describe('KeyPool', () => {
  test('returns the first key initially', () => {
    const pool = new KeyPool(['key-a', 'key-b', 'key-c'])
    expect(pool.get()).toBe('key-a')
  })

  test('rotates to next key after error', () => {
    const pool = new KeyPool(['key-a', 'key-b', 'key-c'])
    pool.get()
    pool.reportError('rate_limit')
    expect(pool.get()).toBe('key-b')
  })

  test('skips keys in cooldown', () => {
    const pool = new KeyPool(['key-a', 'key-b', 'key-c'])
    pool.get() // key-a
    pool.reportError('rate_limit') // cool down key-a, advance to b
    pool.get() // key-b
    pool.reportError('rate_limit') // cool down key-b, advance to c
    expect(pool.get()).toBe('key-c')
  })

  test('resets error count on success', () => {
    const pool = new KeyPool(['key-a', 'key-b'])
    pool.get()
    pool.reportError('default')
    // Now on key-b
    pool.get()
    pool.reportSuccess()
    // key-b should have 0 errors now
    expect(pool.availableCount()).toBe(1) // key-a still cooling, key-b available
  })

  test('returns soonest-expiring key when all are cooling', () => {
    const pool = new KeyPool(['key-a', 'key-b'])
    pool.get() // key-a
    pool.reportError('default') // cool down key-a
    pool.get() // key-b
    pool.reportError('default') // cool down key-b
    // Both cooling but should still return one
    const key = pool.get()
    expect(key === 'key-a' || key === 'key-b').toBe(true)
  })

  test('throws on empty keys array', () => {
    expect(() => new KeyPool([])).toThrow('at least one')
  })

  test('single key pool works without rotation', () => {
    const pool = new KeyPool(['only-key'])
    expect(pool.get()).toBe('only-key')
    pool.reportError('rate_limit')
    expect(pool.get()).toBe('only-key') // No choice but this one
    expect(pool.size()).toBe(1)
  })

  test('availableCount reflects cooldown state', () => {
    const pool = new KeyPool(['key-a', 'key-b', 'key-c'])
    expect(pool.availableCount()).toBe(3)
    pool.get()
    pool.reportError('rate_limit')
    expect(pool.availableCount()).toBe(2)
  })

  test('size returns total keys', () => {
    const pool = new KeyPool(['a', 'b', 'c'])
    expect(pool.size()).toBe(3)
  })
})

describe('KeyPool.classifyError', () => {
  test('classifies rate limit errors', () => {
    expect(KeyPool.classifyError('Error 429: Too Many Requests')).toBe('rate_limit')
    expect(KeyPool.classifyError('rate_limit exceeded')).toBe('rate_limit')
    expect(KeyPool.classifyError('Rate limit reached')).toBe('rate_limit')
  })

  test('classifies auth errors', () => {
    expect(KeyPool.classifyError('401 Unauthorized')).toBe('auth')
    expect(KeyPool.classifyError('Invalid API key provided')).toBe('auth')
    expect(KeyPool.classifyError('403 Forbidden')).toBe('auth')
  })

  test('classifies billing errors', () => {
    expect(KeyPool.classifyError('Billing issue: payment failed')).toBe('billing')
    expect(KeyPool.classifyError('Insufficient funds')).toBe('billing')
  })

  test('defaults to default for unknown errors', () => {
    expect(KeyPool.classifyError('Something weird happened')).toBe('default')
  })
})
