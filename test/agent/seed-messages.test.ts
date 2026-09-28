import { describe, expect, test } from 'bun:test'
import { ConversationHistory } from '../../src/agent/history'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

const seed: ChatMessage[] = [
  { role: 'user', content: 'my cat is named Miso' },
  { role: 'assistant', content: 'cute name' },
]

describe('seeded history', () => {
  test('a seeded transcript is not handed to the extractor again', () => {
    const history = new ConversationHistory(null, 'openai:x')
    const context = { messages: [] as ChatMessage[] } as unknown as Parameters<
      ConversationHistory['seed']
    >[0]
    history.seed(context, seed)
    expect(context.messages).toEqual(seed)

    context.messages.push({ role: 'user', content: 'what is my cat called?' })
    expect(history.takeUnextracted(context.messages)).toEqual([
      { role: 'user', content: 'what is my cat called?' },
    ])
  })

  test('the model sees the seeded turns before the new message', async () => {
    let seen: ChatMessage[] = []
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        seen = req.messages
        return stubResponse({ content: 'Miso' })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'openai:seed',
      seedMessages: seed,
    })

    await agent.run('what is my cat called?')

    const texts = seen.filter((m) => m.role !== 'system').map((m) => m.content)
    expect(texts).toEqual(['my cat is named Miso', 'cute name', 'what is my cat called?'])
  })
})
