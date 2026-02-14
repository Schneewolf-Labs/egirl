import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync } from 'fs'
import { ConversationStore, createConversationStore } from '../../src/conversation/store'
import type { ChatMessage } from '../../src/providers/types'

let store: ConversationStore
let dbPath: string

beforeEach(() => {
  dbPath = join(tmpdir(), `egirl-test-conv-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  store = createConversationStore(dbPath)
})

afterEach(() => {
  store.close()
  try { unlinkSync(dbPath) } catch {}
  try { unlinkSync(dbPath + '-wal') } catch {}
  try { unlinkSync(dbPath + '-shm') } catch {}
})

describe('ConversationStore', () => {
  test('stores and loads messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]

    store.appendMessages('test:session1', messages)
    const loaded = store.loadMessages('test:session1')

    expect(loaded).toHaveLength(2)
    expect(loaded[0]!.role).toBe('user')
    expect(loaded[0]!.content).toBe('Hello')
    expect(loaded[1]!.role).toBe('assistant')
    expect(loaded[1]!.content).toBe('Hi there!')
  })

  test('returns empty array for unknown session', () => {
    const loaded = store.loadMessages('nonexistent')
    expect(loaded).toEqual([])
  })

  test('appends to existing session', () => {
    store.appendMessages('s1', [
      { role: 'user', content: 'first' },
    ])

    store.appendMessages('s1', [
      { role: 'assistant', content: 'second' },
    ])

    const loaded = store.loadMessages('s1')
    expect(loaded).toHaveLength(2)
    expect(loaded[0]!.content).toBe('first')
    expect(loaded[1]!.content).toBe('second')
  })

  test('preserves tool_calls and tool_call_id', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc1', name: 'read_file', arguments: { path: '/foo' } },
        ],
      },
      {
        role: 'tool',
        content: 'file contents',
        tool_call_id: 'tc1',
      },
    ]

    store.appendMessages('s2', messages)
    const loaded = store.loadMessages('s2')

    expect(loaded[0]!.tool_calls).toHaveLength(1)
    expect(loaded[0]!.tool_calls![0]!.name).toBe('read_file')
    expect(loaded[1]!.tool_call_id).toBe('tc1')
  })

  test('deleteSession removes session and messages', () => {
    store.appendMessages('del-me', [
      { role: 'user', content: 'temp' },
    ])

    const deleted = store.deleteSession('del-me')
    expect(deleted).toBe(true)

    const loaded = store.loadMessages('del-me')
    expect(loaded).toEqual([])
  })

  test('deleteSession returns false for nonexistent session', () => {
    expect(store.deleteSession('nope')).toBe(false)
  })

  test('listSessions returns session info', () => {
    store.appendMessages('cli:s1', [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ])
    store.appendMessages('discord:s2', [
      { role: 'user', content: 'x' },
    ])

    const sessions = store.listSessions()
    expect(sessions).toHaveLength(2)

    const s1 = sessions.find(s => s.id === 'cli:s1')
    expect(s1).toBeDefined()
    expect(s1!.channel).toBe('cli')
    expect(s1!.messageCount).toBe(2)

    const s2 = sessions.find(s => s.id === 'discord:s2')
    expect(s2).toBeDefined()
    expect(s2!.channel).toBe('discord')
    expect(s2!.messageCount).toBe(1)
  })

  test('compact removes old sessions', () => {
    // Create a session and manually backdate it
    store.appendMessages('old-session', [
      { role: 'user', content: 'ancient' },
    ])

    // Compact with maxAgeDays=0 should remove everything
    const result = store.compact({ maxAgeDays: 0, maxMessages: 1000 })
    expect(result.sessionsDeleted).toBe(1)
    expect(result.messagesDeleted).toBe(1)

    expect(store.loadMessages('old-session')).toEqual([])
  })

  test('compact trims oversized sessions', () => {
    const messages: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `message ${i}`,
    }))

    store.appendMessages('big-session', messages)

    // Keep max 5 messages
    const result = store.compact({ maxAgeDays: 365, maxMessages: 5 })
    expect(result.messagesDeleted).toBe(15)

    const remaining = store.loadMessages('big-session')
    expect(remaining).toHaveLength(5)
    // Should keep the newest (highest ID) messages
    expect(remaining[0]!.content).toBe('message 15')
  })

  test('ignores empty message arrays', () => {
    store.appendMessages('s1', [])
    const sessions = store.listSessions()
    expect(sessions).toHaveLength(0)
  })
})
