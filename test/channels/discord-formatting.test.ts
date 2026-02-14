import { describe, expect, test } from 'bun:test'
import {
  formatToolCallsMarkdown,
  splitMessage,
  truncateResult,
} from '../../src/channels/discord/formatting'

describe('formatToolCallsMarkdown', () => {
  test('formats no-arg tool call', () => {
    const result = formatToolCallsMarkdown([{ id: '1', name: 'git_status', arguments: {} }])
    expect(result).toBe('git_status()')
  })

  test('formats single-arg tool call inline', () => {
    const result = formatToolCallsMarkdown([
      { id: '1', name: 'read_file', arguments: { path: '/foo/bar.ts' } },
    ])
    expect(result).toBe('read_file(path: /foo/bar.ts)')
  })

  test('formats multi-arg tool call as JSON', () => {
    const result = formatToolCallsMarkdown([
      { id: '1', name: 'edit_file', arguments: { path: '/foo.ts', old: 'a', new: 'b' } },
    ])
    expect(result).toContain('edit_file(')
    expect(result).toContain('"path"')
  })

  test('formats long single-arg as JSON', () => {
    const longPath = '/very/long/path/that/exceeds/sixty/characters/to/trigger/json/formatting.ts'
    const result = formatToolCallsMarkdown([
      { id: '1', name: 'read_file', arguments: { path: longPath } },
    ])
    // Should fall through to JSON since value > 60 chars
    expect(result).toContain('read_file(')
  })

  test('formats multiple tool calls on separate lines', () => {
    const result = formatToolCallsMarkdown([
      { id: '1', name: 'read_file', arguments: { path: 'a.ts' } },
      { id: '2', name: 'read_file', arguments: { path: 'b.ts' } },
    ])
    const lines = result.split('\n')
    expect(lines).toHaveLength(2)
  })
})

describe('truncateResult', () => {
  test('returns empty string for whitespace-only input', () => {
    expect(truncateResult('   ', 100)).toBe('')
  })

  test('returns trimmed content within limit', () => {
    expect(truncateResult('  hello  ', 100)).toBe('hello')
  })

  test('truncates and adds ellipsis for long content', () => {
    const long = 'a'.repeat(200)
    const result = truncateResult(long, 50)
    expect(result.length).toBe(53) // 50 + '...'
    expect(result.endsWith('...')).toBe(true)
  })
})

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
