import { describe, expect, test } from 'bun:test'
import { estimateMessagesTokens, estimateTokens, truncateToTokenLimit } from '../../src/util/tokens'

describe('estimateTokens', () => {
  test('estimates based on ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  test('rounds up for partial tokens', () => {
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  test('handles longer text', () => {
    const text = 'a'.repeat(400)
    expect(estimateTokens(text)).toBe(100)
  })
})

describe('estimateMessagesTokens', () => {
  test('counts tokens across multiple messages with overhead', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]
    const result = estimateMessagesTokens(messages)
    // "Hello" = ceil(5/4) = 2, + 4 overhead = 6
    // "Hi there" = ceil(8/4) = 2, + 4 overhead = 6
    expect(result).toBe(12)
  })

  test('returns 0 for empty array', () => {
    expect(estimateMessagesTokens([])).toBe(0)
  })

  test('includes per-message overhead', () => {
    const messages = [{ role: 'user', content: '' }]
    // empty content = 0 tokens + 4 overhead
    expect(estimateMessagesTokens(messages)).toBe(4)
  })
})

describe('truncateToTokenLimit', () => {
  test('returns original text when within limit', () => {
    expect(truncateToTokenLimit('hello', 100)).toBe('hello')
  })

  test('truncates text exceeding token limit', () => {
    const text = 'a'.repeat(100)
    const result = truncateToTokenLimit(text, 10) // 10 tokens * 4 chars = 40 chars
    expect(result.length).toBeLessThan(100)
    expect(result).toEndWith('...')
  })

  test('appends ellipsis to truncated text', () => {
    const text = 'a'.repeat(100)
    const result = truncateToTokenLimit(text, 5)
    expect(result).toEndWith('...')
  })

  test('returns original when exactly at limit', () => {
    const text = 'a'.repeat(40) // 40 chars / 4 = 10 tokens
    const result = truncateToTokenLimit(text, 10)
    expect(result).toBe(text)
  })
})
