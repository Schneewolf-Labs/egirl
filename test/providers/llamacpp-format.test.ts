import { describe, expect, test } from 'bun:test'
import { formatMessagesForQwen3 } from '../../src/providers/qwen3-format'
import type { ChatMessage, ToolDefinition } from '../../src/providers/types'
/**
 * Test the LlamaCppProvider.formatMessages logic by importing a testable
 * extraction. Since formatMessages is a private method, we test via the
 * exported helper: formatMessagesForQwen3.
 */
import { buildToolsSection } from '../../src/tools/format'

describe('formatMessagesForQwen3', () => {
  test('reconstructs tool call XML in assistant messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read the file' },
      {
        role: 'assistant',
        content: 'Let me read that file.',
        tool_calls: [{ id: 'call_0', name: 'read_file', arguments: { path: '/etc/hosts' } }],
      },
      { role: 'tool', content: '127.0.0.1 localhost', tool_call_id: 'call_0' },
    ]

    const formatted = formatMessagesForQwen3(messages)

    // Assistant message should include reconstructed <tool_call> XML
    const assistantMsg = formatted.find((m) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.content).toContain('<tool_call>')
    expect(assistantMsg?.content).toContain('read_file')
    expect(assistantMsg?.content).toContain('/etc/hosts')
    expect(assistantMsg?.content).toContain('</tool_call>')
    expect(assistantMsg?.content).toContain('Let me read that file.')
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

    const content = formatted[0]?.content as string
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

    // assistant + one grouped user turn holding both tool results. (A continuation turn is
    // appended after them, because this conversation has no plain user query — see the
    // template-safety tests below — so assert the grouping directly, not by total length.)
    expect(formatted[0]?.role).toBe('assistant')
    const userMsg = formatted[1]
    if (!userMsg) throw new Error('Expected grouped user message')
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

    const toolResponse = formatted[1]
    if (!toolResponse) throw new Error('Expected tool response')
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
})

describe('buildToolsSection (system prompt injection)', () => {
  const tools: ToolDefinition[] = [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path' } },
        required: ['path'],
      },
    },
  ]

  test('returns empty string when no tools provided', () => {
    expect(buildToolsSection(undefined)).toBe('')
    expect(buildToolsSection([])).toBe('')
  })

  test('includes tool definitions in <tools> tags', () => {
    const section = buildToolsSection(tools)
    expect(section).toContain('<tools>')
    expect(section).toContain('</tools>')
    expect(section).toContain('read_file')
    expect(section).toContain('Read a file')
  })

  test('includes <tool_call> format instructions', () => {
    const section = buildToolsSection(tools)
    expect(section).toContain('<tool_call>')
    expect(section).toContain('</tool_call>')
    expect(section).toContain('"name"')
    expect(section).toContain('"arguments"')
  })

  test('tool definitions are valid JSON', () => {
    const section = buildToolsSection(tools)
    const toolsMatch = section.match(/<tools>([\s\S]*?)<\/tools>/)
    expect(toolsMatch).toBeTruthy()
    const toolsContent = toolsMatch?.[1]?.trim() ?? ''
    // Each line should be parseable JSON
    for (const line of toolsContent.split('\n').filter((l) => l.trim())) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  test('system prompt with injected tools is well-formed', () => {
    const systemContent = 'You are helpful.'
    const withTools = systemContent + buildToolsSection(tools)
    expect(withTools).toContain('You are helpful.')
    expect(withTools).toContain('# Tools')
    expect(withTools).toContain('read_file')
  })

  test('includes multiple tools', () => {
    const multiTools: ToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'write_file',
        description: 'Write a file',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ]
    const section = buildToolsSection(multiTools)
    expect(section).toContain('read_file')
    expect(section).toContain('write_file')
  })
})

describe('formatMessagesForQwen3 multiturn', () => {
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
    expect(formatted[1]?.content).toContain('glob_files')
    expect(formatted[1]?.content).toContain('<tool_call>')

    // First tool response
    expect(formatted[2]?.role).toBe('user')
    expect(formatted[2]?.content).toContain('a.txt\nb.txt')

    // Second assistant should have both read_file tool calls
    const secondAssistant = formatted[3]?.content as string
    expect((secondAssistant.match(/<tool_call>/g) || []).length).toBe(2)

    // Second tool response should group both results
    expect(formatted[4]?.role).toBe('user')
    const toolResponses = formatted[4]?.content as string
    expect((toolResponses.match(/<tool_response>/g) || []).length).toBe(2)
    expect(toolResponses).toContain('aaa')
    expect(toolResponses).toContain('bbb')

    // Final assistant response is plain
    expect(formatted[5]?.content).toBe('Found a.txt with "aaa" and b.txt with "bbb".')
  })

  describe('always leaves a user query for the template', () => {
    // Qwen3's chat template raises `No user query found in messages` — a hard 400 from
    // llama.cpp that fails the whole request — when every user turn is a <tool_response>
    // wrapper. A long run reaches that shape after trimming drops the task prompt, leaving
    // only assistant tool-calls and their results. This is what auto-paused a real task
    // repeatedly, so the formatter must never produce it.
    const isQuery = (m: { role: string; content: unknown }) =>
      m.role === 'user' &&
      typeof m.content === 'string' &&
      !/^<tool_response>[\s\S]*<\/tool_response>$/.test(m.content.trim())

    test('appends a continuation when only tool results remain on the user side', () => {
      const formatted = formatMessagesForQwen3([
        { role: 'assistant', content: '', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/x' } }] },
        { role: 'tool', content: 'file contents' },
      ])
      expect(formatted.some(isQuery)).toBe(true)
      // The appended turn is at the end, so the tool results still precede it.
      expect(formatted[formatted.length - 1]?.role).toBe('user')
    })

    test('does not add anything when a real query is already present', () => {
      const formatted = formatMessagesForQwen3([
        { role: 'user', content: 'Read the file.' },
        { role: 'assistant', content: '', tool_calls: [{ id: '1', name: 'read_file', arguments: {} }] },
        { role: 'tool', content: 'contents' },
      ])
      // Exactly the three turns it started with — no synthetic continuation.
      expect(formatted.filter((m) => m.role === 'user').length).toBe(2) // the query + the tool_response
      expect(formatted.some((m) => m.content === 'Continue based on the tool results above.')).toBe(false)
    })

    test('handles a conversation with no user turn at all', () => {
      const formatted = formatMessagesForQwen3([
        { role: 'assistant', content: '', tool_calls: [{ id: '1', name: 'x', arguments: {} }] },
        { role: 'tool', content: 'r' },
      ])
      expect(formatted.some(isQuery)).toBe(true)
    })
  })

})
