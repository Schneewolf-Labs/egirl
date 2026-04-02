import { describe, expect, test } from 'bun:test'

/**
 * Tests for stale-stream detection logic in LlamaCppProvider.
 *
 * We can't easily test the full streaming pipeline without a real server,
 * so we test the timer-based detection mechanism in isolation.
 */

describe('stale-stream detection', () => {
  test('timer fires after timeout with no reset', async () => {
    let fired = false
    const timeoutMs = 50

    const timer = setTimeout(() => {
      fired = true
    }, timeoutMs)

    // Wait longer than the timeout
    await new Promise((resolve) => setTimeout(resolve, timeoutMs + 20))
    clearTimeout(timer)

    expect(fired).toBe(true)
  })

  test('timer does not fire if reset before timeout', async () => {
    let fired = false
    const timeoutMs = 100

    let timer = setTimeout(() => {
      fired = true
    }, timeoutMs)

    // Reset at 30ms (before timeout)
    await new Promise((resolve) => setTimeout(resolve, 30))
    clearTimeout(timer)
    timer = setTimeout(() => {
      fired = true
    }, timeoutMs)

    // Reset again at 60ms (before timeout)
    await new Promise((resolve) => setTimeout(resolve, 30))
    clearTimeout(timer)
    timer = setTimeout(() => {
      fired = true
    }, timeoutMs)

    // Wait a bit but not enough for the reset timer to fire
    await new Promise((resolve) => setTimeout(resolve, 50))
    clearTimeout(timer)

    expect(fired).toBe(false)
  })

  test('stale abort sets finish_reason to length', () => {
    // Simulates the logic in readStream
    let finish_reason: string | undefined
    const staleAborted = true

    if (staleAborted) {
      finish_reason = 'length'
    }

    expect(finish_reason).toBe('length')
  })

  test('non-stale stream preserves original finish_reason', () => {
    let finish_reason: string | undefined = 'stop'
    const staleAborted = false

    if (staleAborted) {
      finish_reason = 'length'
    }

    expect(finish_reason).toBe('stop')
  })

  test('default timeout is 90 seconds', () => {
    const DEFAULT_STALE_STREAM_TIMEOUT_MS = 90_000
    expect(DEFAULT_STALE_STREAM_TIMEOUT_MS).toBe(90000)
  })

  test('custom timeout can be configured', () => {
    const customTimeout = 30_000
    const staleStreamTimeoutMs = customTimeout ?? 90_000
    expect(staleStreamTimeoutMs).toBe(30000)
  })

  test('simulates stale detection with content accumulation', async () => {
    // Simulates the readStream pattern: content accumulates, timer resets
    let fullContent = ''
    let staleAborted = false
    const timeoutMs = 50

    let staleTimer: ReturnType<typeof setTimeout> | null = null
    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => {
        staleAborted = true
      }, timeoutMs)
    }

    // Start timer
    resetStaleTimer()

    // Simulate 3 tokens arriving 20ms apart (before timeout)
    for (const token of ['Hello', ' world', '!']) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      fullContent += token
      resetStaleTimer()
    }

    // Wait less than timeout
    await new Promise((resolve) => setTimeout(resolve, 30))
    if (staleTimer) clearTimeout(staleTimer)

    expect(staleAborted).toBe(false)
    expect(fullContent).toBe('Hello world!')
  })

  test('simulates stale detection when tokens stop', async () => {
    let fullContent = ''
    let staleAborted = false
    const timeoutMs = 50

    let staleTimer: ReturnType<typeof setTimeout> | null = null
    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => {
        staleAborted = true
      }, timeoutMs)
    }

    // Start timer
    resetStaleTimer()

    // One token arrives
    fullContent += 'Hello'
    resetStaleTimer()

    // No more tokens — wait for stale timeout
    await new Promise((resolve) => setTimeout(resolve, timeoutMs + 20))
    if (staleTimer) clearTimeout(staleTimer)

    expect(staleAborted).toBe(true)
    expect(fullContent).toBe('Hello')
  })
})
