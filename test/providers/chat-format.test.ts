import { describe, expect, test } from 'bun:test'
import { toApiMessages } from '../../src/providers/chat-format'
import type { ChatMessage } from '../../src/providers/types'

describe('toApiMessages', () => {
  test('assistant tool calls go out in the OpenAI shape with JSON-string arguments', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read the file' },
      {
        role: 'assistant',
        content: 'Let me read that file.',
        tool_calls: [{ id: 'call_0', name: 'read_file', arguments: { path: '/etc/hosts' } }],
      },
      { role: 'tool', content: '127.0.0.1 localhost', tool_call_id: 'call_0' },
    ]

    const api = toApiMessages(messages)

    expect(api[1]).toEqual({
      role: 'assistant',
      content: 'Let me read that file.',
      tool_calls: [
        {
          id: 'call_0',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"/etc/hosts"}' },
        },
      ],
    })
    // No markup of any dialect is rendered client-side: that is the template's job.
    expect(JSON.stringify(api)).not.toContain('<tool_call>')
    expect(JSON.stringify(api)).not.toContain('<tool_response>')
  })

  test('tool results keep the tool role and their call id', () => {
    const api = toApiMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_0', name: 'read_file', arguments: { path: 'a.txt' } },
          { id: 'call_1', name: 'read_file', arguments: { path: 'b.txt' } },
        ],
      },
      { role: 'tool', content: 'contents of a', tool_call_id: 'call_0' },
      { role: 'tool', content: 'contents of b', tool_call_id: 'call_1' },
    ])

    expect(api.slice(2)).toEqual([
      { role: 'tool', tool_call_id: 'call_0', content: 'contents of a' },
      { role: 'tool', tool_call_id: 'call_1', content: 'contents of b' },
    ])
  })

  test('an image result becomes a text tool turn plus a user turn carrying the image', () => {
    const api = toApiMessages([
      { role: 'user', content: 'screenshot please' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c0', name: 'screenshot', arguments: {} }],
      },
      { role: 'tool', content: 'data:image/png;base64,AAAA', tool_call_id: 'c0' },
    ])

    expect(api[2]).toEqual({ role: 'tool', tool_call_id: 'c0', content: 'Screenshot captured' })
    expect(api[3]?.role).toBe('user')
    expect(api[3]?.content).toEqual([
      { type: 'text', text: 'Screenshot from the tool call above.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
  })

  test('plain messages pass through untouched', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]
    expect(toApiMessages(messages)).toEqual(messages)
  })

  test('a conversation with no user query gets a continuation turn appended', () => {
    const api = toApiMessages([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c0', name: 'ls', arguments: {} }] },
      { role: 'tool', content: 'a.txt', tool_call_id: 'c0' },
    ])
    const last = api[api.length - 1]
    expect(last?.role).toBe('user')
    expect(last?.content).toBe('Continue based on the tool results above.')
  })

  test('a conversation that still has a user query is left alone', () => {
    const api = toApiMessages([
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c0', name: 'ls', arguments: {} }] },
      { role: 'tool', content: 'a.txt', tool_call_id: 'c0' },
    ])
    expect(api).toHaveLength(3)
  })

  test('an empty conversation stays empty', () => {
    expect(toApiMessages([])).toEqual([])
  })
})
