import { describe, expect, test } from 'bun:test'
import { AsyncQueue, delay, retry, timeout } from '../../src/util/async'

describe('delay', () => {
  test('resolves after specified time', async () => {
    const start = Date.now()
    await delay(50)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(40) // allow some jitter
  })
})

describe('retry', () => {
  test('returns result on first success', async () => {
    const result = await retry(async () => 42)
    expect(result).toBe(42)
  })

  test('retries on failure and succeeds', async () => {
    let attempt = 0
    const result = await retry(
      async () => {
        attempt++
        if (attempt < 3) throw new Error('fail')
        return 'success'
      },
      { maxAttempts: 3, delayMs: 10 },
    )
    expect(result).toBe('success')
    expect(attempt).toBe(3)
  })

  test('throws after max attempts', async () => {
    let attempt = 0
    try {
      await retry(
        async () => {
          attempt++
          throw new Error('always fails')
        },
        { maxAttempts: 3, delayMs: 10 },
      )
      // Should not reach here
      expect(true).toBe(false)
    } catch (error) {
      expect((error as Error).message).toBe('always fails')
      expect(attempt).toBe(3)
    }
  })

  test('calls onError callback for each failure', async () => {
    const errors: number[] = []
    try {
      await retry(
        async () => {
          throw new Error('fail')
        },
        {
          maxAttempts: 3,
          delayMs: 10,
          onError: (_err, attempt) => errors.push(attempt),
        },
      )
    } catch {
      // expected
    }
    expect(errors).toEqual([1, 2, 3])
  })

  test('uses default options when none provided', async () => {
    const result = await retry(async () => 'ok')
    expect(result).toBe('ok')
  })
})

describe('timeout', () => {
  test('resolves when promise completes in time', async () => {
    const result = await timeout(Promise.resolve('done'), 1000)
    expect(result).toBe('done')
  })

  test('rejects when promise exceeds timeout', async () => {
    try {
      await timeout(new Promise((resolve) => setTimeout(resolve, 500)), 10)
      expect(true).toBe(false)
    } catch (error) {
      expect((error as Error).message).toContain('timed out')
    }
  })

  test('uses custom error message', async () => {
    try {
      await timeout(new Promise((resolve) => setTimeout(resolve, 500)), 10, 'Custom timeout')
      expect(true).toBe(false)
    } catch (error) {
      expect((error as Error).message).toBe('Custom timeout')
    }
  })
})

describe('AsyncQueue', () => {
  test('push and pop in order', async () => {
    const queue = new AsyncQueue<number>()
    queue.push(1)
    queue.push(2)
    queue.push(3)

    expect(await queue.pop()).toBe(1)
    expect(await queue.pop()).toBe(2)
    expect(await queue.pop()).toBe(3)
  })

  test('pop waits for push', async () => {
    const queue = new AsyncQueue<string>()

    // Push after a delay
    setTimeout(() => queue.push('delayed'), 20)

    const result = await queue.pop()
    expect(result).toBe('delayed')
  })

  test('reports correct length', () => {
    const queue = new AsyncQueue<number>()
    expect(queue.length).toBe(0)

    queue.push(1)
    queue.push(2)
    expect(queue.length).toBe(2)
  })

  test('push resolves waiting pop immediately', async () => {
    const queue = new AsyncQueue<number>()

    // Start pop before push
    const popPromise = queue.pop()
    // Queue should be empty since pop is waiting
    expect(queue.length).toBe(0)

    queue.push(42)
    const result = await popPromise
    expect(result).toBe(42)
    // Item went directly to resolver, queue stays empty
    expect(queue.length).toBe(0)
  })
})
