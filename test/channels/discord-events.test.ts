import { describe, test, expect } from 'bun:test'
import { createDiscordEventHandler, buildToolCallPrefix } from '../../src/channels/discord/events'

describe('createDiscordEventHandler', () => {
  test('tracks tool call start entries', () => {
    const { handler, state } = createDiscordEventHandler()

    handler.onToolCallStart!([
      { id: '1', name: 'read_file', arguments: { path: 'foo.ts' } },
    ])

    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]!.call).toContain('read_file')
    expect(state.entries[0]!.result).toBeUndefined()
  })

  test('attaches result to matching entry', () => {
    const { handler, state } = createDiscordEventHandler()

    handler.onToolCallStart!([
      { id: '1', name: 'read_file', arguments: { path: 'foo.ts' } },
    ])

    handler.onToolCallComplete!('1', 'read_file', { success: true, output: 'file contents here' })

    expect(state.entries[0]!.result).toContain('ok')
    expect(state.entries[0]!.result).toContain('file contents here')
  })

  test('marks failed results with err', () => {
    const { handler, state } = createDiscordEventHandler()

    handler.onToolCallStart!([
      { id: '1', name: 'read_file', arguments: { path: 'missing.ts' } },
    ])

    handler.onToolCallComplete!('1', 'read_file', { success: false, output: 'File not found' })

    expect(state.entries[0]!.result).toContain('err')
    expect(state.entries[0]!.result).toContain('File not found')
  })
})

describe('buildToolCallPrefix', () => {
  test('returns empty string for no entries', () => {
    expect(buildToolCallPrefix({ entries: [] })).toBe('')
  })

  test('wraps entries in code block', () => {
    const state = {
      entries: [
        { call: 'read_file(path: foo.ts)', result: '  -> ok: contents' },
      ],
    }
    const prefix = buildToolCallPrefix(state)
    expect(prefix).toContain('```')
    expect(prefix).toContain('read_file')
    expect(prefix).toContain('ok: contents')
  })

  test('handles entries without results', () => {
    const state = {
      entries: [
        { call: 'read_file(path: foo.ts)' },
      ],
    }
    const prefix = buildToolCallPrefix(state)
    expect(prefix).toContain('read_file')
    expect(prefix).not.toContain('undefined')
  })
})
