import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import { ConversationStore } from '../../src/conversation/store'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

/**
 * Provider stub that answers normal turns with numbered replies and
 * compaction/summarization requests with a fixed summary.
 */
function makeProvider(): LLMProvider {
  let n = 0
  return {
    name: 'stub',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const system = req.messages[0]
      if (
        system?.role === 'system' &&
        typeof system.content === 'string' &&
        system.content.includes('context compaction')
      ) {
        return stubResponse({ content: 'compacted summary of earlier chat' })
      }
      n++
      return stubResponse({ content: `reply ${n}` })
    },
  }
}

function makeAgent(store: ConversationStore, sessionId: string): AgentLoop {
  return new AgentLoop({
    config: makeConfig(makeWorkspace()),
    toolExecutor: makeExecutorWithNoop(),
    localProvider: makeProvider(),
    sessionId,
    conversationStore: store,
  })
}

describe('conversation persistence', () => {
  test('persists messages across runs without duplication', async () => {
    const store = new ConversationStore(':memory:')
    const agent = makeAgent(store, 'test:persist')

    await agent.run('first')
    await agent.run('second')

    const persisted = store.loadMessages('test:persist')
    expect(persisted.map((m) => [m.role, m.content])).toEqual([
      ['user', 'first'],
      ['assistant', 'reply 1'],
      ['user', 'second'],
      ['assistant', 'reply 2'],
    ])
  })

  test('hydrates messages and summary from the store on construction', async () => {
    const store = new ConversationStore(':memory:')
    store.appendMessages('test:hydrate', [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
    ])
    store.updateSummary('test:hydrate', 'old summary')

    const agent = makeAgent(store, 'test:hydrate')

    expect(agent.getContext().messages.length).toBe(2)
    expect(agent.getContext().conversationSummary).toBe('old summary')

    // New turns append after the hydrated history without re-persisting it
    await agent.run('new question')

    const persisted = store.loadMessages('test:hydrate')
    expect(persisted.map((m) => m.content)).toEqual([
      'old question',
      'old answer',
      'new question',
      'reply 1',
    ])
  })

  test('resetSession clears the live context and stored history', async () => {
    const store = new ConversationStore(':memory:')
    const agent = makeAgent(store, 'test:reset')

    await agent.run('hello')
    expect(store.loadMessages('test:reset').length).toBe(2)

    agent.resetSession()

    expect(agent.getContext().messages.length).toBe(0)
    expect(store.loadMessages('test:reset').length).toBe(0)
  })
})

describe('manual compaction', () => {
  test('compactNow keeps the last four messages and re-persists only those', async () => {
    const store = new ConversationStore(':memory:')
    const agent = makeAgent(store, 'test:compact')

    await agent.run('one')
    await agent.run('two')
    await agent.run('three')
    expect(agent.getContext().messages.length).toBe(6)

    const result = await agent.compactNow()

    expect(result).toEqual({ messagesBefore: 6, messagesAfter: 4 })
    expect(agent.getContext().messages.length).toBe(4)
    expect(agent.getContext().messages[0]?.content).toBe('two')

    const persisted = store.loadMessages('test:compact')
    expect(persisted.map((m) => m.content)).toEqual(['two', 'reply 2', 'three', 'reply 3'])
  })

  test('compaction summary lands before the next turn reads it', async () => {
    const store = new ConversationStore(':memory:')
    const agent = makeAgent(store, 'test:compact-summary')

    await agent.run('one')
    await agent.run('two')
    await agent.run('three')
    await agent.compactNow()

    // The next run awaits the in-flight compaction before inference
    await agent.run('four')

    expect(agent.getContext().conversationSummary).toBe('compacted summary of earlier chat')
    expect(store.loadSummary('test:compact-summary')).toBe('compacted summary of earlier chat')
  })

  test('compactNow is a no-op with fewer than four messages', async () => {
    const store = new ConversationStore(':memory:')
    const agent = makeAgent(store, 'test:compact-small')

    await agent.run('only')

    const result = await agent.compactNow()

    expect(result).toEqual({ messagesBefore: 2, messagesAfter: 2 })
    expect(store.loadMessages('test:compact-small').length).toBe(2)
  })
})
