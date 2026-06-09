import { describe, expect, test } from 'bun:test'
import { SessionMutex } from '../../src/agent/session-mutex'

describe('SessionMutex', () => {
  test('allows a single run through immediately', async () => {
    const mutex = new SessionMutex()
    const result = await mutex.run(async () => 'done')
    expect(result).toBe('done')
    expect(mutex.isLocked()).toBe(false)
    expect(mutex.pending).toBe(0)
  })

  test('serializes concurrent runs', async () => {
    const mutex = new SessionMutex()
    const order: number[] = []

    const run1 = mutex.run(async () => {
      order.push(1)
      await sleep(50)
      order.push(2)
      return 'first'
    })

    const run2 = mutex.run(async () => {
      order.push(3)
      return 'second'
    })

    const [result1, result2] = await Promise.all([run1, run2])

    expect(result1).toBe('first')
    expect(result2).toBe('second')
    // run2 should not start until run1 finishes
    expect(order).toEqual([1, 2, 3])
  })

  test('releases lock on error', async () => {
    const mutex = new SessionMutex()

    try {
      await mutex.run(async () => {
        throw new Error('boom')
      })
    } catch {
      // expected
    }

    expect(mutex.isLocked()).toBe(false)

    // Should still work after error
    const result = await mutex.run(async () => 'recovered')
    expect(result).toBe('recovered')
  })

  test('processes queue in FIFO order', async () => {
    const mutex = new SessionMutex()
    const order: string[] = []

    // Hold the lock
    const blocker = mutex.run(async () => {
      await sleep(50)
      order.push('blocker')
    })

    // Queue up multiple runs
    const a = mutex.run(async () => {
      order.push('a')
    })
    const b = mutex.run(async () => {
      order.push('b')
    })
    const c = mutex.run(async () => {
      order.push('c')
    })

    expect(mutex.pending).toBe(3)

    await Promise.all([blocker, a, b, c])

    expect(order).toEqual(['blocker', 'a', 'b', 'c'])
    expect(mutex.isLocked()).toBe(false)
    expect(mutex.pending).toBe(0)
  })

  test('acquire and release work manually', async () => {
    const mutex = new SessionMutex()

    await mutex.acquire()
    expect(mutex.isLocked()).toBe(true)

    mutex.release()
    expect(mutex.isLocked()).toBe(false)
  })

  test('queued run rejects after acquire timeout', async () => {
    const mutex = new SessionMutex(30)

    const blocker = mutex.run(async () => {
      await sleep(100)
      return 'blocker'
    })

    const queued = mutex.run(async () => 'never')

    await expect(queued).rejects.toThrow('Timed out')
    expect(mutex.pending).toBe(0)

    // Blocker still completes and the lock is released
    expect(await blocker).toBe('blocker')
    expect(mutex.isLocked()).toBe(false)
  })

  test('timed-out waiter is skipped on release', async () => {
    const mutex = new SessionMutex(30)
    const order: string[] = []

    const blocker = mutex.run(async () => {
      await sleep(100)
      order.push('blocker')
    })

    const timedOut = mutex.run(async () => {
      order.push('timed-out')
    })

    await expect(timedOut).rejects.toThrow('Timed out')

    await blocker

    // A new run after the blocker should acquire normally
    await mutex.run(async () => {
      order.push('after')
    })

    expect(order).toEqual(['blocker', 'after'])
    expect(mutex.isLocked()).toBe(false)
  })

  test('timeout of 0 disables queue timeout', async () => {
    const mutex = new SessionMutex(0)

    const blocker = mutex.run(async () => {
      await sleep(60)
      return 'blocker'
    })

    const queued = mutex.run(async () => 'queued')

    expect(await blocker).toBe('blocker')
    expect(await queued).toBe('queued')
  })

  test('queued runs proceed after error in earlier run', async () => {
    const mutex = new SessionMutex()
    const order: string[] = []

    const failing = mutex.run(async () => {
      order.push('fail-start')
      throw new Error('fail')
    })

    const succeeding = mutex.run(async () => {
      order.push('success')
      return 'ok'
    })

    await expect(failing).rejects.toThrow('fail')
    const result = await succeeding
    expect(result).toBe('ok')
    expect(order).toEqual(['fail-start', 'success'])
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
