import { describe, test, expect } from 'bun:test'
import type { ChatMessage } from '../../src/providers/types'

/**
 * Test the LlamaCppProvider.formatMessages logic by importing a testable
 * extraction. Since formatMessages is a private method, we test via the
 * exported helper: formatMessagesForQwen3.
 */
import { formatMessagesForQwen3 } from '../../src/providers/qwen3-format'

describe('formatMessagesForQwen3', () => {
  test('reconstructs tool call XML in assistant messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read the file' },
      {
        role: 'assistant',
        content: 'Let me read that file.',
        tool_calls: [
          { id: 'call_0', name: 'read_file', arguments: { path: '/etc/hosts' } },
        ],
      },
      { role: 'tool', content: '127.0.0.1 localhost', tool_call_id: 'call_0' },
    ]

    const formatted = formatMessagesForQwen3(messages)

    // Assistant message should include reconstructed <tool_call> XML
    const assistantMsg = formatted.find(m => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.content).toContain('<tool_call>')
    expect(assistantMsg!.content).toContain('read_file')
    expect(assistantMsg!.content).toContain('/etc/hosts')
    expect(assistantMsg!.content).toContain('</tool_call>')
    expect(assistantMsg!.content).toContain('Let me read that file.')
  })

  test('reconstructs multiple tool calls in assistant messages', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Checking both.',
        tool_calls: [
          { id: 'call_0', name: 'read_file', arguments: { path: 'a.txt' } },
          { id: 'call_1', name: 'read_file', arguments: { path: 'b.txt' } },
        ],
      },
    ]

    const formatted = formatMessagesForQwen3(messages)

    const content = formatted[0]!.content as string
    const openTags = (content.match(/<tool_call>/g) || []).length
    const closeTags = (content.match(/<\/tool_call>/g) || []).length
    expect(openTags).toBe(2)
    expect(closeTags).toBe(2)
    expect(content).toContain('a.txt')
    expect(content).toContain('b.txt')
  })

  test('groups consecutive tool results into single user message', () => {
    const messages: ChatMessage[] = [
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
    ]

    const formatted = formatMessagesForQwen3(messages)

    // Should have 2 messages: assistant + grouped user
    expect(formatted).toHaveLength(2)

    const userMsg = formatted[1]!
    expect(userMsg.role).toBe('user')
    const content = userMsg.content as string
    expect(content).toContain('<tool_response>')
    expect(content).toContain('contents of a')
    expect(content).toContain('contents of b')

    // Both responses should be in the same message
    const responseCount = (content.match(/<tool_response>/g) || []).length
    expect(responseCount).toBe(2)
  })

  test('tool results use user role with <tool_response> tags', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_0', name: 'exec', arguments: { cmd: 'ls' } }],
      },
      { role: 'tool', content: 'file1.txt\nfile2.txt', tool_call_id: 'call_0' },
    ]

    const formatted = formatMessagesForQwen3(messages)

    const toolResponse = formatted[1]!
    expect(toolResponse.role).toBe('user')
    expect(toolResponse.content).toContain('<tool_response>')
    expect(toolResponse.content).toContain('file1.txt\nfile2.txt')
    expect(toolResponse.content).toContain('</tool_response>')
  })

  test('preserves regular messages unchanged', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]

    const formatted = formatMessagesForQwen3(messages)

    expect(formatted).toHaveLength(3)
    expect(formatted[0]).toEqual({ role: 'system', content: 'You are helpful.' })
    expect(formatted[1]).toEqual({ role: 'user', content: 'Hello' })
    expect(formatted[2]).toEqual({ role: 'assistant', content: 'Hi there!' })
  })

  test('handles multiturn tool use conversation', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'What files are in this directory?' },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [{ id: 'call_0', name: 'glob_files', arguments: { pattern: '*' } }],
      },
      { role: 'tool', content: 'a.txt\nb.txt', tool_call_id: 'call_0' },
      {
        role: 'assistant',
        content: 'Let me read both.',
        tool_calls: [
          { id: 'call_0', name: 'read_file', arguments: { path: 'a.txt' } },
          { id: 'call_1', name: 'read_file', arguments: { path: 'b.txt' } },
        ],
      },
      { role: 'tool', content: 'aaa', tool_call_id: 'call_0' },
      { role: 'tool', content: 'bbb', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'Found a.txt with "aaa" and b.txt with "bbb".' },
    ]

    const formatted = formatMessagesForQwen3(messages)

    // user, assistant(+tool_call), user(tool_response), assistant(+2 tool_calls), user(2 tool_responses), assistant
    expect(formatted).toHaveLength(6)

    // First assistant should have glob_files tool call
    expect(formatted[1]!.content).toContain('glob_files')
    expect(formatted[1]!.content).toContain('<tool_call>')

    // First tool response
    expect(formatted[2]!.role).toBe('user')
    expect(formatted[2]!.content).toContain('a.txt\nb.txt')

    // Second assistant should have both read_file tool calls
    const secondAssistant = formatted[3]!.content as string
    expect((secondAssistant.match(/<tool_call>/g) || []).length).toBe(2)

    // Second tool response should group both results
    expect(formatted[4]!.role).toBe('user')
    const toolResponses = formatted[4]!.content as string
    expect((toolResponses.match(/<tool_response>/g) || []).length).toBe(2)
    expect(toolResponses).toContain('aaa')
    expect(toolResponses).toContain('bbb')

    // Final assistant response is plain
    expect(formatted[5]!.content).toBe('Found a.txt with "aaa" and b.txt with "bbb".')
  })
})
