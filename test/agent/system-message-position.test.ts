import { describe, expect, test } from 'bun:test'
import { chatWithContextWindow } from '../../src/agent/chat'
import type { ChatMessage, ChatResponse, LLMProvider } from '../../src/providers/types'

/**
 * Qwen's chat template refuses a system message anywhere but index 0:
 *
 *   400 Unable to generate parser for this template
 *   raise_exception('System message must be at the beginning')
 *
 * The conversation summary used to be injected as its own system message ahead of the history,
 * which put one at index 1 and hard-failed every long agentic run the moment the summariser
 * fired. It surfaced as an opaque template error twelve tool calls into a real task, which is a
 * miserable way to find out — hence this test.
 */

/** Captures whatever the provider is handed, so the assembled message list can be inspected. */
function capturingProvider(): { provider: LLMProvider; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = []
  const provider: LLMProvider = {
    name: 'capture',
    async chat(req) {
      seen.push(req.messages)
      return {
        content: 'ok',
        toolCalls: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      } as ChatResponse
    },
  } as unknown as LLMProvider
  return { provider, seen }
}

const history: ChatMessage[] = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second question' },
]

describe('assembled messages', () => {
  test('puts no system message after index 0 when a summary is present', async () => {
    const { provider, seen } = capturingProvider()
    await chatWithContextWindow({
      provider,
      systemPrompt: 'You are egirl.',
      messages: history,
      conversationSummary: '- user asked about X\n- tool Y returned Z',
      tools: [],
      contextLength: 32768,
    })

    const sent = seen[0]!
    const systemIndexes = sent.map((m, i) => (m.role === 'system' ? i : -1)).filter((i) => i >= 0)
    expect(systemIndexes).toEqual([0])
  })

  test('keeps the summary content, folded into the system prompt', async () => {
    const { provider, seen } = capturingProvider()
    await chatWithContextWindow({
      provider,
      systemPrompt: 'You are egirl.',
      messages: history,
      conversationSummary: '- user asked about X',
      tools: [],
      contextLength: 32768,
    })

    const first = String(seen[0]![0]!.content)
    expect(first).toContain('You are egirl.')
    expect(first).toContain('user asked about X')
  })

  test('hoists a stray system message out of the history', async () => {
    const { provider, seen } = capturingProvider()
    await chatWithContextWindow({
      provider,
      systemPrompt: 'You are egirl.',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'INLINE NOTE' },
        { role: 'user', content: 'again' },
      ],
      tools: [],
      contextLength: 32768,
    })

    const sent = seen[0]!
    const systemIndexes = sent.map((m, i) => (m.role === 'system' ? i : -1)).filter((i) => i >= 0)
    expect(systemIndexes).toEqual([0])
    expect(String(sent[0]!.content)).toContain('INLINE NOTE')
  })

  test('sends exactly one system message with no summary', async () => {
    const { provider, seen } = capturingProvider()
    await chatWithContextWindow({
      provider,
      systemPrompt: 'You are egirl.',
      messages: history,
      tools: [],
      contextLength: 32768,
    })

    expect(seen[0]!.filter((m) => m.role === 'system')).toHaveLength(1)
    expect(seen[0]![0]!.role).toBe('system')
  })
})
