import { describe, expect, test } from 'bun:test'
import {
  buildToolCallPrefix,
  createNarration,
  formatToolCallCompact,
} from '../../src/channels/narration'

describe('formatToolCallCompact', () => {
  test('uses the tool-specific icon, label and key argument', () => {
    expect(
      formatToolCallCompact({
        id: '1',
        name: 'web_search',
        arguments: { query: 'schneewolf labs llc' },
      }),
    ).toBe('🔍 Web Search: "schneewolf labs llc"')
  })

  test('falls back to a family icon for prefixed tools', () => {
    expect(
      formatToolCallCompact({ id: '1', name: 'git_status', arguments: { path: '/repo' } }),
    ).toBe('🔀 Git: "/repo"')
  })

  test('humanizes unknown tools and picks the first string argument', () => {
    expect(
      formatToolCallCompact({
        id: '1',
        name: 'some_new_thing',
        arguments: { count: 3, target: 'abc' },
      }),
    ).toBe('🛠️ Some New Thing: "abc"')
  })

  test('truncates long arguments and collapses whitespace', () => {
    const line = formatToolCallCompact({
      id: '1',
      name: 'execute_command',
      arguments: { command: `echo ${'x'.repeat(80)}\n  && ls` },
    })
    expect(line.startsWith('💻 Shell: "echo xxx')).toBe(true)
    expect(line.endsWith('…"')).toBe(true)
    expect(line).not.toContain('\n')
  })

  test('omits the argument when there is nothing to show', () => {
    expect(formatToolCallCompact({ id: '1', name: 'memory_list', arguments: {} })).toBe('🧠 Memory')
  })
})

describe('createNarration', () => {
  test('collects one line per tool call and ignores results', () => {
    const { handler, state } = createNarration()
    handler.onToolCallStart?.([
      { id: '1', name: 'read_file', arguments: { path: 'a.ts' } },
      { id: '2', name: 'read_file', arguments: { path: 'b.ts' } },
    ])
    handler.onToolCallComplete?.('1', 'read_file', { success: true, output: 'secret contents' })
    expect(state.lines).toEqual(['📄 Read: "a.ts"', '📄 Read: "b.ts"'])
  })
})

describe('buildToolCallPrefix', () => {
  test('is empty when no tools ran', () => {
    expect(buildToolCallPrefix({ lines: [] }, 'plain')).toBe('')
    expect(buildToolCallPrefix({ lines: [] }, 'markdown')).toBe('')
  })

  test('plain surfaces get the lines and a blank line', () => {
    expect(buildToolCallPrefix({ lines: ['a', 'b'] }, 'plain')).toBe('a\nb\n\n')
  })

  test('markdown surfaces get a code block', () => {
    expect(buildToolCallPrefix({ lines: ['a', 'b'] }, 'markdown')).toBe('```\na\nb\n```\n')
  })
})
