import { describe, expect, test } from 'bun:test'
/**
 * Test Anthropic message preparation by instantiating the provider with a
 * dummy key and calling prepareMessages via a test helper.
 *
 * Since prepareMessages is private, we test indirectly through
 * prepareAnthropicMessages which is exported for testing.
 */
import { prepareAnthropicMessages } from '../../src/providers/anthropic'
import type { ChatMessage } from '../../src/providers/types'

describe('prepareAnthropicMessages', () => {
  test('merges consecutive tool results into single user message', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Reading both files.',
        tool_calls: [
          { id: 'call_0', name: 'read_file', arguments: { path: 'a.txt' } },
          { id: 'call_1', name: 'read_file', arguments: { path: 'b.txt' } },
        ],
      },
      { role: 'tool', content: 'contents of a', tool_call_id: 'call_0' },
      { role: 'tool', content: 'contents of b', tool_call_id: 'call_1' },
    ]

    const { messages: prepared } = prepareAnthropicMessages(messages)

    // assistant + one merged user message
    expect(prepared).toHaveLength(2)

    const userMsg = prepared[1]
    if (!userMsg) throw new Error('Expected user message')
    expect(userMsg.role).toBe('user')

    // Content should be an array with both tool_result blocks
    const content = userMsg.content as Array<{ type: string; tool_use_id?: string }>
    expect(content).toHaveLength(2)
    expect(content[0]?.type).toBe('tool_result')
    expect(content[0]?.tool_use_id).toBe('call_0')
    expect(content[1]?.type).toBe('tool_result')
    expect(content[1]?.tool_use_id).toBe('call_1')
  })

  test('single tool result still works', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_0', name: 'exec', arguments: { cmd: 'ls' } }],
      },
      { role: 'tool', content: 'file1.txt', tool_call_id: 'call_0' },
    ]

    const { messages: prepared } = prepareAnthropicMessages(messages)

    expect(prepared).toHaveLength(2)
    const content = prepared[1]?.content as Array<{ type: string; tool_use_id?: string }>
    expect(content).toHaveLength(1)
    expect(content[0]?.type).toBe('tool_result')
    expect(content[0]?.tool_use_id).toBe('call_0')
  })

  test('extracts system prompt', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are egirl.' },
      { role: 'user', content: 'Hello' },
    ]

    const { systemPrompt, messages: prepared } = prepareAnthropicMessages(messages)

    expect(systemPrompt).toBe('You are egirl.')
    expect(prepared).toHaveLength(1)
    expect(prepared[0]?.role).toBe('user')
  })

  test('handles multiturn tool use conversation', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'List and read files' },
      {
        role: 'assistant',
        content: 'Let me list files first.',
        tool_calls: [{ id: 'call_0', name: 'glob_files', arguments: { pattern: '*' } }],
      },
      { role: 'tool', content: 'a.txt\nb.txt', tool_call_id: 'call_0' },
      {
        role: 'assistant',
        content: 'Now reading both.',
        tool_calls: [
          { id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } },
          { id: 'call_2', name: 'read_file', arguments: { path: 'b.txt' } },
        ],
      },
      { role: 'tool', content: 'aaa', tool_call_id: 'call_1' },
      { role: 'tool', content: 'bbb', tool_call_id: 'call_2' },
      { role: 'assistant', content: 'Done.' },
    ]

    const { messages: prepared } = prepareAnthropicMessages(messages)

    // user, assistant(tool_use), user(tool_result), assistant(2 tool_use), user(2 tool_result), assistant
    expect(prepared).toHaveLength(6)

    // Check alternation: user, assistant, user, assistant, user, assistant
    expect(prepared[0]?.role).toBe('user')
    expect(prepared[1]?.role).toBe('assistant')
    expect(prepared[2]?.role).toBe('user')
    expect(prepared[3]?.role).toBe('assistant')
    expect(prepared[4]?.role).toBe('user')
    expect(prepared[5]?.role).toBe('assistant')

    // Second tool response should have 2 results merged
    const secondToolResponse = prepared[4]?.content as Array<{ type: string }>
    expect(secondToolResponse).toHaveLength(2)
  })
})
