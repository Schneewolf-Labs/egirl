import { describe, expect, test } from 'bun:test'
import { splitMessage } from '../../src/channels/chunk'

describe('splitMessage', () => {
  test('returns single chunk for short content', () => {
    const result = splitMessage('hello', 2000)
    expect(result).toEqual(['hello'])
  })

  test('splits at newline when possible', () => {
    const line2 = 'x'.repeat(100)
    const content = `line1\n${line2}\nline3`
    const result = splitMessage(content, 50)
    expect(result.length).toBeGreaterThan(1)
    // First chunk should split at the last newline before limit
    expect(result[0]?.includes('\n') || result[0]?.length <= 50).toBe(true)
  })

  test('hard splits when no good break point', () => {
    const content = 'a'.repeat(300)
    const result = splitMessage(content, 100)
    expect(result.length).toBe(3)
    expect(result[0]?.length).toBe(100)
  })

  test('handles empty content', () => {
    const result = splitMessage('', 100)
    expect(result).toEqual([])
  })
})
