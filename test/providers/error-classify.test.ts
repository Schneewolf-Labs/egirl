import { describe, expect, test } from 'bun:test'
import { classifyProviderError, isRetryable, retryDelay } from '../../src/providers/error-classify'

describe('classifyProviderError', () => {
  test('classifies rate limit errors', () => {
    expect(classifyProviderError('429 Too Many Requests')).toBe('rate_limit')
    expect(classifyProviderError('rate_limit: exceeded quota')).toBe('rate_limit')
    expect(classifyProviderError('Rate limit reached for model')).toBe('rate_limit')
    expect(classifyProviderError('Server overloaded')).toBe('rate_limit')
  })

  test('classifies auth errors', () => {
    expect(classifyProviderError('401 Unauthorized')).toBe('auth')
    expect(classifyProviderError('Invalid API key provided')).toBe('auth')
    expect(classifyProviderError('403 Forbidden')).toBe('auth')
    expect(classifyProviderError('Access denied to this resource')).toBe('auth')
    expect(classifyProviderError('Authentication failed')).toBe('auth')
  })

  test('classifies context overflow errors', () => {
    expect(classifyProviderError('context_length_exceeded')).toBe('context_overflow')
    expect(classifyProviderError('Too many tokens: 50000 > 32768')).toBe('context_overflow')
    expect(classifyProviderError('Maximum tokens exceeded')).toBe('context_overflow')
    expect(classifyProviderError('Context window limit reached')).toBe('context_overflow')
  })

  test('classifies non-retryable errors', () => {
    expect(classifyProviderError('Billing error: payment declined')).toBe('non_retryable')
    expect(classifyProviderError('Insufficient funds in account')).toBe('non_retryable')
  })

  test('classifies transient errors', () => {
    expect(classifyProviderError('500 Internal Server Error')).toBe('transient')
    expect(classifyProviderError('502 Bad Gateway')).toBe('transient')
    expect(classifyProviderError('503 Service Unavailable')).toBe('transient')
    expect(classifyProviderError('ECONNREFUSED localhost:8080')).toBe('transient')
    expect(classifyProviderError('fetch failed')).toBe('transient')
    expect(classifyProviderError('Network error')).toBe('transient')
  })

  test('defaults to transient for unknown errors', () => {
    expect(classifyProviderError('Something unexpected happened')).toBe('transient')
  })
})

describe('isRetryable', () => {
  test('rate_limit is retryable', () => {
    expect(isRetryable('rate_limit')).toBe(true)
  })

  test('transient is retryable', () => {
    expect(isRetryable('transient')).toBe(true)
  })

  test('auth is not retryable', () => {
    expect(isRetryable('auth')).toBe(false)
  })

  test('context_overflow is not retryable', () => {
    expect(isRetryable('context_overflow')).toBe(false)
  })

  test('non_retryable is not retryable', () => {
    expect(isRetryable('non_retryable')).toBe(false)
  })
})

describe('retryDelay', () => {
  test('rate_limit has longer delays', () => {
    expect(retryDelay('rate_limit', 0)).toBe(2000)
    expect(retryDelay('rate_limit', 1)).toBe(4000)
    expect(retryDelay('rate_limit', 2)).toBe(6000)
  })

  test('rate_limit caps at 10s', () => {
    expect(retryDelay('rate_limit', 10)).toBe(10000)
  })

  test('transient uses exponential backoff', () => {
    expect(retryDelay('transient', 0)).toBe(1000)
    expect(retryDelay('transient', 1)).toBe(2000)
    expect(retryDelay('transient', 2)).toBe(4000)
  })
})
