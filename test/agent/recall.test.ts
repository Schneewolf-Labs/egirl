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

/** Like makeMemoryStub, but the hits depend on which word the query starts with. */
function makeQueryMemoryStub(byQuery: Record<string, Array<{ key: string; value: string }>>): {
  memory: MemoryManager
} {
  const stub = {
    searchHybrid: async (query: string, _limit: number) => {
      const hits = byQuery[query.split(' ')[0] ?? ''] ?? []
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
  return { memory: stub as unknown as MemoryManager }
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

  test('leaves the earlier recall in place and skips an identical one', async () => {
    const config = makeConfig(makeWorkspace())
    config.memory.proactiveRetrieval = true
    const { memory, searchCalls } = makeMemoryStub([{ key: 'k', value: 'remembered-value' }])

    const agent = new AgentLoop({
      config,
      toolExecutor: makeExecutorWithNoop(),
      localProvider: makeReplyProvider(),
      sessionId: 'test:recall-stable',
      memory,
    })

    await agent.run('first question')
    await agent.run('second question')

    // Both turns recalled the same thing. The first recall stays exactly where it was — moving
    // it would edit the prompt mid-history and invalidate the server's KV prefix cache — and
    // the identical second one is not inserted at all.
    const messages = agent.getContext().messages
    expect(searchCalls()).toBe(2)
    expect(messages.filter(isRecall).length).toBe(1)
    expect(isRecall(messages[0] as ChatMessage)).toBe(true)
    expect(messages.map((m) => (isRecall(m) ? 'recall' : m.content))).toEqual([
      'recall',
      'first question',
      'reply 1',
      'second question',
      'reply 2',
    ])
  })

  test('keeps every distinct recall, each directly before its own question', async () => {
    const config = makeConfig(makeWorkspace())
    config.memory.proactiveRetrieval = true
    const { memory } = makeQueryMemoryStub({
      first: [{ key: 'a', value: 'about-first' }],
      second: [{ key: 'b', value: 'about-second' }],
    })

    const agent = new AgentLoop({
      config,
      toolExecutor: makeExecutorWithNoop(),
      localProvider: makeReplyProvider(),
      sessionId: 'test:recall-distinct',
      memory,
    })

    await agent.run('first question')
    await agent.run('second question')

    const messages = agent.getContext().messages
    const recalls = messages.filter(isRecall)
    expect(recalls.length).toBe(2)
    expect(recalls[0]?.content).toContain('about-first')
    expect(recalls[1]?.content).toContain('about-second')
    const secondIdx = messages.findIndex((m) => m.content === 'second question')
    expect(isRecall(messages[secondIdx - 1] as ChatMessage)).toBe(true)
    expect(messages[secondIdx - 1]?.content).toContain('about-second')
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
    // Exactly user/assistant pairs, no dropped or duplicated messages
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
