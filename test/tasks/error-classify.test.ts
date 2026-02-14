import { describe, test, expect } from 'bun:test'
import { classifyError, getRetryPolicy } from '../../src/tasks/error-classify'

describe('classifyError', () => {
  test('classifies rate limit errors', () => {
    expect(classifyError('Rate limit exceeded')).toBe('rate_limit')
    expect(classifyError('Error 429: too many requests')).toBe('rate_limit')
    expect(classifyError('You have exceeded your current quota')).toBe('rate_limit')
    expect(classifyError('resource_exhausted')).toBe('rate_limit')
    expect(classifyError('API overloaded, try again later')).toBe('rate_limit')
  })

  test('classifies auth errors', () => {
    expect(classifyError('Invalid API key provided')).toBe('auth')
    expect(classifyError('Error 401 unauthorized')).toBe('auth')
    expect(classifyError('Error 403 forbidden')).toBe('auth')
    expect(classifyError('Access denied')).toBe('auth')
    expect(classifyError('Token has expired')).toBe('auth')
  })

  test('classifies timeout errors', () => {
    expect(classifyError('Request timed out')).toBe('timeout')
    expect(classifyError('Deadline exceeded')).toBe('timeout')
    expect(classifyError('ETIMEDOUT')).toBe('timeout')
    expect(classifyError('ECONNRESET')).toBe('timeout')
  })

  test('classifies context overflow errors', () => {
    expect(classifyError('context_length_exceeded')).toBe('context_overflow')
    expect(classifyError('Too many tokens in request')).toBe('context_overflow')
    expect(classifyError('Maximum context window exceeded')).toBe('context_overflow')
  })

  test('classifies transient errors', () => {
    expect(classifyError('500 Internal Server Error')).toBe('transient')
    expect(classifyError('502 Bad Gateway')).toBe('transient')
    expect(classifyError('503 Service Unavailable')).toBe('transient')
    expect(classifyError('ECONNREFUSED')).toBe('transient')
    expect(classifyError('fetch failed: network error')).toBe('transient')
  })

  test('returns unknown for unrecognized errors', () => {
    expect(classifyError('Something weird happened')).toBe('unknown')
    expect(classifyError('TypeError: cannot read properties of undefined')).toBe('unknown')
  })
})

describe('getRetryPolicy', () => {
  test('rate_limit: exponential backoff', () => {
    const p1 = getRetryPolicy('rate_limit', 1)
    expect(p1.shouldRetry).toBe(true)
    expect(p1.shouldPause).toBe(false)
    expect(p1.backoffMs).toBe(60 * 1000 * 5) // 5 min

    const p2 = getRetryPolicy('rate_limit', 2)
    expect(p2.backoffMs).toBe(60 * 1000 * 25) // 25 min

    const p3 = getRetryPolicy('rate_limit', 3)
    expect(p3.backoffMs).toBe(60 * 60 * 1000) // capped at 1hr (5^3=125min > 60min cap)

    // Check cap
    const p10 = getRetryPolicy('rate_limit', 10)
    expect(p10.backoffMs).toBeLessThanOrEqual(60 * 60 * 1000) // 1hr cap
    expect(p10.shouldRetry).toBe(true)
  })

  test('auth: immediate pause', () => {
    const p = getRetryPolicy('auth', 1)
    expect(p.shouldRetry).toBe(false)
    expect(p.shouldPause).toBe(true)
  })

  test('timeout: retry once then pause', () => {
    const p1 = getRetryPolicy('timeout', 1)
    expect(p1.shouldRetry).toBe(true)
    expect(p1.shouldPause).toBe(false)

    const p2 = getRetryPolicy('timeout', 2)
    expect(p2.shouldRetry).toBe(false)
    expect(p2.shouldPause).toBe(true)
  })

  test('transient: 5 retries then pause', () => {
    const p1 = getRetryPolicy('transient', 1)
    expect(p1.shouldRetry).toBe(true)

    const p4 = getRetryPolicy('transient', 4)
    expect(p4.shouldRetry).toBe(true)

    const p5 = getRetryPolicy('transient', 5)
    expect(p5.shouldRetry).toBe(false)
    expect(p5.shouldPause).toBe(true)
  })

  test('context_overflow: immediate pause', () => {
    const p = getRetryPolicy('context_overflow', 1)
    expect(p.shouldRetry).toBe(false)
    expect(p.shouldPause).toBe(true)
  })

  test('unknown: 3 retries then pause', () => {
    const p1 = getRetryPolicy('unknown', 1)
    expect(p1.shouldRetry).toBe(true)

    const p2 = getRetryPolicy('unknown', 2)
    expect(p2.shouldRetry).toBe(true)

    const p3 = getRetryPolicy('unknown', 3)
    expect(p3.shouldRetry).toBe(false)
    expect(p3.shouldPause).toBe(true)
  })
})
