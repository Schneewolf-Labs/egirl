/**
 * Persistence sanitization — the cross-run tool-call poison fix.
 *
 * A response carrying a valid tool call alongside leftover malformed <tool_call> markup takes
 * the tool-executing path, which persists the raw content as a normal assistant message. Left
 * in the store, that markup reloads next run and the model imitates its own broken syntax,
 * mangling tool calls immediately. persistNew must strip stranded markup from assistant content
 * before it reaches the store — while leaving valid tool syntax and ordinary prose untouched.
 */

import { describe, expect, test } from 'bun:test'
import { ConversationHistory } from '../../src/agent/history'
import { ConversationStore } from '../../src/conversation/store'
import type { ChatMessage } from '../../src/providers/types'

// The exact malformed form the q8-27B emitted that poisoned Zero's context: a <tool_call>
// block whose body is not parseable JSON, so the parser cannot turn it into a call.
const MANGLED =
  'Let me checkpoint the finding, then continue.\n<tool_call>\n<function="edit_file","arguments":{"path":"NOTES.md","old_text":"x"}'

describe('persistence sanitization', () => {
  test('strips stranded tool-call markup from a persisted assistant message', () => {
    const store = new ConversationStore(':memory:')
    const history = new ConversationHistory(store, 'test:poison')

    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      // The leak path: valid structured tool_calls AND malformed markup left in content.
      {
        role: 'assistant',
        content: MANGLED,
        tool_calls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a' } }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    ]
    history.persistNew(messages)

    const stored = store.loadMessages('test:poison')
    const assistant = stored.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    // The malformed markup is gone; the legitimate preamble survives.
    expect(assistant?.content).not.toContain('<tool_call>')
    expect(assistant?.content).not.toContain('<function=')
    expect(assistant?.content).toContain('Let me checkpoint the finding')
    // The structured call is untouched — only the content residue was cleaned.
    expect(assistant?.tool_calls?.[0]?.name).toBe('read_file')
  })

  test('leaves ordinary assistant prose untouched', () => {
    const store = new ConversationStore(':memory:')
    const history = new ConversationHistory(store, 'test:clean')
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'The answer is 391. Here is why: ...' },
    ]
    history.persistNew(messages)
    const stored = store.loadMessages('test:clean')
    expect(stored[1]?.content).toBe('The answer is 391. Here is why: ...')
  })

  test('reload after sanitization carries no mangled markup forward', () => {
    const store = new ConversationStore(':memory:')
    new ConversationHistory(store, 'test:reload').persistNew([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: MANGLED,
        tool_calls: [{ id: 'c1', name: 'noop', arguments: {} }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    ])

    // A fresh run hydrates from the store — the poison must not be present to imitate.
    const reloaded = store.loadMessages('test:reload')
    const joined = reloaded.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    expect(joined).not.toContain('<tool_call>')
    expect(joined).not.toContain('<function=')
  })
})
