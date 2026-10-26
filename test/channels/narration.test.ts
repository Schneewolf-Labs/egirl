import { describe, expect, test } from 'bun:test'
import {
  buildThinkingBlock,
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

  test('does not hook thinking unless asked', () => {
    const { handler } = createNarration()
    expect(handler.onThinking).toBeUndefined()
  })

  test('captures the thinking block when asked', () => {
    const { handler, state } = createNarration({ captureThinking: true })
    handler.onThinking?.('weighing the options')
    expect(state.thinking).toBe('weighing the options')
  })
})

describe('buildThinkingBlock', () => {
  test('is empty when there is no reasoning', () => {
    expect(buildThinkingBlock(undefined, 'markdown')).toBe('')
    expect(buildThinkingBlock('   ', 'plain')).toBe('')
  })

  test('markdown surfaces get a blockquoted reasoning aside', () => {
    expect(buildThinkingBlock('line one\nline two', 'markdown')).toBe(
      '💭 **reasoning**\n> line one\n> line two\n\n',
    )
  })

  test('plain surfaces get a labelled block', () => {
    expect(buildThinkingBlock('thinking hard', 'plain')).toBe('💭 reasoning:\nthinking hard\n\n')
  })

  test('long reasoning is truncated', () => {
    const block = buildThinkingBlock('x'.repeat(5000), 'plain')
    expect(block).toContain('…')
    expect(block.length).toBeLessThan(1400)
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
