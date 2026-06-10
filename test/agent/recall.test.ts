import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import { ConversationStore } from '../../src/conversation/store'
import type { MemoryManager } from '../../src/memory'
import type { ChatMessage, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

const RECALL_MARKER = '[Recalled context from memory'

function isRecall(m: ChatMessage): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(RECALL_MARKER)
}

function makeMemoryStub(hits: Array<{ key: string; value: string }>): {
  memory: MemoryManager
  searchCalls: () => number
} {
  let calls = 0
  const stub = {
    searchHybrid: async (_query: string, _limit: number) => {
      calls++
      return hits.map((hit, i) => ({
        matchType: 'hybrid' as const,
        score: 0.9,
        memory: {
          id: `m${i}`,
          key: hit.key,
          value: hit.value,
          category: 'general',
          source: 'manual',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }))
    },
  }
  return { memory: stub as unknown as MemoryManager, searchCalls: () => calls }
}

function makeReplyProvider(): LLMProvider {
  let n = 0
  return {
    name: 'stub',
    async chat(): Promise<ChatResponse> {
      n++
      return stubResponse({ content: `reply ${n}` })
    },
  }
}

describe('proactive memory recall', () => {
  test('injects recalled memories directly before the user message', async () => {
    const config = makeConfig(makeWorkspace())
    config.memory.proactiveRetrieval = true
    const { memory } = makeMemoryStub([{ key: 'project/status', value: 'remembered-value' }])

    const agent = new AgentLoop({
      config,
      toolExecutor: makeExecutorWithNoop(),
      localProvider: makeReplyProvider(),
      sessionId: 'test:recall',
      memory,
    })

    await agent.run('what was the project status?')

    const messages = agent.getContext().messages
    expect(messages.length).toBe(3)
    expect(isRecall(messages[0] as ChatMessage)).toBe(true)
    expect(messages[0]?.content).toContain('remembered-value')
    expect(messages[1]?.role).toBe('user')
    expect(messages[1]?.content).toBe('what was the project status?')
    expect(messages[2]?.role).toBe('assistant')
  })

  test('replaces the previous recall message on subsequent runs', async () => {
    const config = makeConfig(makeWorkspace())
    config.memory.proactiveRetrieval = true
    const { memory, searchCalls } = makeMemoryStub([{ key: 'k', value: 'remembered-value' }])

    const agent = new AgentLoop({
      config,
      toolExecutor: makeExecutorWithNoop(),
      localProvider: makeReplyProvider(),
      sessionId: 'test:recall-replace',
      memory,
    })

    await agent.run('first question')
    await agent.run('second question')

    const messages = agent.getContext().messages
    const recalls = messages.filter(isRecall)
    expect(recalls.length).toBe(1)
    expect(searchCalls()).toBe(2)

    // The single recall message sits directly before the second user message
    const recallIdx = messages.findIndex(isRecall)
    expect(messages[recallIdx + 1]?.content).toBe('second question')
  })

  test('never persists recall messages to the conversation store', async () => {
    const config = makeConfig(makeWorkspace())
    config.memory.proactiveRetrieval = true
    const { memory } = makeMemoryStub([{ key: 'k', value: 'remembered-value' }])

    const store = new ConversationStore(':memory:')
    const agent = new AgentLoop({
      config,
      toolExecutor: makeExecutorWithNoop(),
      localProvider: makeReplyProvider(),
      sessionId: 'test:recall-persist',
      memory,
      conversationStore: store,
    })

    await agent.run('first question')
    await agent.run('second question')

    const persisted = store.loadMessages('test:recall-persist')
    expect(persisted.some(isRecall)).toBe(false)
    // Watermark stays aligned when the old recall is spliced out:
    // exactly user/assistant pairs, no dropped or duplicated messages
    expect(persisted.map((m) => m.content)).toEqual([
      'first question',
      'reply 1',
      'second question',
      'reply 2',
    ])
  })

  test('skips recall when proactive retrieval is disabled', async () => {
    const config = makeConfig(makeWorkspace())
    config.memory.proactiveRetrieval = false
    const { memory, searchCalls } = makeMemoryStub([{ key: 'k', value: 'remembered-value' }])

    const agent = new AgentLoop({
      config,
      toolExecutor: makeExecutorWithNoop(),
      localProvider: makeReplyProvider(),
      sessionId: 'test:recall-off',
      memory,
    })

    await agent.run('question')

    expect(searchCalls()).toBe(0)
    expect(agent.getContext().messages.some(isRecall)).toBe(false)
  })

  test('injects nothing when no memories clear the score threshold', async () => {
    const config = makeConfig(makeWorkspace())
    config.memory.proactiveRetrieval = true
    config.memory.scoreThreshold = 0.95
    const { memory } = makeMemoryStub([{ key: 'k', value: 'remembered-value' }])

    const agent = new AgentLoop({
      config,
      toolExecutor: makeExecutorWithNoop(),
      localProvider: makeReplyProvider(),
      sessionId: 'test:recall-threshold',
      memory,
    })

    await agent.run('question')

    expect(agent.getContext().messages.some(isRecall)).toBe(false)
  })
})
