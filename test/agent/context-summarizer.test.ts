import { describe, test, expect, mock } from 'bun:test'
import { summarizeMessages, formatSummaryMessage } from '../../src/agent/context-summarizer'
import type { ChatMessage, LLMProvider, ChatRequest, ChatResponse } from '../../src/providers/types'

function createMockProvider(response: string): LLMProvider {
  return {
    name: 'mock',
    chat: mock(async (_req: ChatRequest): Promise<ChatResponse> => ({
      content: response,
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'mock-model',
    })),
  }
}

function createFailingProvider(): LLMProvider {
  return {
    name: 'mock-failing',
    chat: mock(async () => { throw new Error('Connection refused') }),
  }
}

describe('summarizeMessages', () => {
  test('generates summary from conversation messages', async () => {
    const provider = createMockProvider('- User asked to read test.txt\n- File contained config values')
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read test.txt for me' },
      {
        role: 'assistant',
        content: 'Reading the file...',
        tool_calls: [{ id: 'call_0', name: 'read_file', arguments: { path: 'test.txt' } }],
      },
      { role: 'tool', content: 'port=8080\nhost=localhost', tool_call_id: 'call_0' },
      { role: 'assistant', content: 'The file contains config values: port=8080 and host=localhost.' },
    ]

    const summary = await summarizeMessages(messages, provider)

    expect(summary).toBeTruthy()
    expect(summary).toContain('test.txt')
    expect(provider.chat).toHaveBeenCalledTimes(1)
  })

  test('merges with existing summary when provided', async () => {
    const provider = createMockProvider('- Previously discussed auth setup\n- Now working on file reading')
    const existingSummary = '- User set up authentication system'
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Now read the config file' },
      { role: 'assistant', content: 'Reading config...' },
    ]

    const summary = await summarizeMessages(messages, provider, existingSummary)

    expect(summary).toBeTruthy()
    // The mock provider's response includes the merged summary
    expect(summary).toContain('auth')

    // Verify the prompt included the existing summary
    const chatCall = (provider.chat as ReturnType<typeof mock>).mock.calls[0]
    const userMessage = chatCall[0].messages[1]
    expect(typeof userMessage.content === 'string' && userMessage.content).toContain('existing summary')
  })

  test('returns empty string for empty messages', async () => {
    const provider = createMockProvider('should not be called')
    const summary = await summarizeMessages([], provider)

    expect(summary).toBe('')
    expect(provider.chat).not.toHaveBeenCalled()
  })

  test('falls back to extraction when LLM fails', async () => {
    const provider = createFailingProvider()
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Help me fix the login bug' },
      {
        role: 'assistant',
        content: 'Looking into it',
        tool_calls: [{ id: 'call_0', name: 'read_file', arguments: { path: 'auth.ts' } }],
      },
      { role: 'tool', content: 'file contents...', tool_call_id: 'call_0' },
    ]

    const summary = await summarizeMessages(messages, provider)

    // Fallback should extract user messages and tool names
    expect(summary).toContain('Help me fix the login bug')
    expect(summary).toContain('read_file')
  })

  test('falls back with existing summary preserved', async () => {
    const provider = createFailingProvider()
    const existing = '- Previously discussed database schema'
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Now add the migration' },
    ]

    const summary = await summarizeMessages(messages, provider, existing)

    expect(summary).toContain('database schema')
    expect(summary).toContain('add the migration')
  })

  test('truncates very long tool results in transcript', async () => {
    const provider = createMockProvider('- User read a large file')
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read the log' },
      { role: 'tool', content: 'x'.repeat(10000), tool_call_id: 'call_0' },
    ]

    await summarizeMessages(messages, provider)

    // The transcript sent to the LLM should have truncated tool results
    const chatCall = (provider.chat as ReturnType<typeof mock>).mock.calls[0]
    const userContent = chatCall[0].messages[1].content as string
    expect(userContent.length).toBeLessThan(10000)
  })

  test('skips system messages except memory recalls', async () => {
    const provider = createMockProvider('- User asked about API keys')
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'system', content: '[Recalled memories relevant to this message:\n- API key is stored in .env]' },
      { role: 'user', content: 'Where is my API key?' },
    ]

    await summarizeMessages(messages, provider)

    const chatCall = (provider.chat as ReturnType<typeof mock>).mock.calls[0]
    const userContent = chatCall[0].messages[1].content as string
    // Should include memory recall but not generic system messages
    expect(userContent).toContain('Memory recall')
    expect(userContent).not.toContain('helpful assistant')
  })
})

describe('formatSummaryMessage', () => {
  test('creates a system message with summary', () => {
    const msg = formatSummaryMessage('- User asked about X\n- Tool Y returned Z')

    expect(msg.role).toBe('system')
    expect(typeof msg.content === 'string' && msg.content).toContain('Conversation summary')
    expect(typeof msg.content === 'string' && msg.content).toContain('User asked about X')
  })
})
