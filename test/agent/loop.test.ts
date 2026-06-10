import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import { ConversationStore } from '../../src/conversation/store'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { createToolExecutor } from '../../src/tools/executor'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

describe('AgentLoop max turns exhaustion', () => {
  test('forces a final no-tools response instead of reusing stale history', async () => {
    let callCount = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        callCount++
        // While tools are offered, keep calling them — exhausting maxTurns
        if (req.tools && req.tools.length > 0) {
          return stubResponse({
            tool_calls: [{ id: `call_${callCount}`, name: 'noop', arguments: { n: callCount } }],
            finish_reason: 'tool_calls',
          })
        }
        // Forced final inference offers no tools
        return stubResponse({ content: 'Final summary of progress.' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:maxturns',
    })

    const response = await agent.run('do something', { maxTurns: 2 })

    expect(response.content).toBe('Final summary of progress.')
    expect(response.turns).toBe(2)
    // 2 tool turns + 1 forced final inference
    expect(callCount).toBe(3)
    // The forced response is recorded in context as the closing assistant message
    const messages = agent.getContext().messages
    expect(messages[messages.length - 1]?.content).toBe('Final summary of progress.')
  })
})

describe('AgentLoop error persistence', () => {
  test('persists the user message when the provider throws', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        throw new Error('401 unauthorized')
      },
    }

    const store = new ConversationStore(':memory:')
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:err',
      conversationStore: store,
    })

    await expect(agent.run('important message')).rejects.toThrow('401 unauthorized')

    const persisted = store.loadMessages('test:err')
    expect(persisted.length).toBe(1)
    expect(persisted[0]?.role).toBe('user')
    expect(persisted[0]?.content).toBe('important message')
  })
})

describe('AgentLoop abort', () => {
  test('returns aborted flag without calling the provider when pre-aborted', async () => {
    let called = false
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        called = true
        return stubResponse({ content: 'should not happen' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:abort',
    })

    const controller = new AbortController()
    controller.abort()

    const response = await agent.run('hello', { signal: controller.signal })

    expect(response.aborted).toBe(true)
    expect(response.content).toBe('')
    expect(called).toBe(false)
  })

  test('skips remaining tool calls after abort and keeps results paired', async () => {
    const controller = new AbortController()
    let chatCalls = 0

    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        chatCalls++
        if (chatCalls === 1) {
          return stubResponse({
            tool_calls: [
              { id: 'call_a', name: 'noop', arguments: { step: 1 } },
              { id: 'call_b', name: 'noop', arguments: { step: 2 } },
            ],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'done' })
      },
    }

    const executor = createToolExecutor()
    executor.register({
      definition: {
        name: 'noop',
        description: 'aborts the run on first execution',
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => {
        controller.abort()
        return { success: true, output: 'ok' }
      },
    })

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: executor,
      localProvider: provider,
      sessionId: 'test:abort-tools',
    })

    // An events handler forces the serial tool path where per-call abort applies
    const response = await agent.run('go', {
      signal: controller.signal,
      events: { onAfterToolExec: () => {} },
    })

    expect(response.aborted).toBe(true)

    // Both tool calls have paired tool results in context
    const messages = agent.getContext().messages
    const toolMessages = messages.filter((m) => m.role === 'tool')
    expect(toolMessages.length).toBe(2)
    expect(toolMessages[1]?.content).toContain('Skipped')

    // No further inference happened after abort
    expect(chatCalls).toBe(1)
  })
})

describe('AgentLoop continuation', () => {
  test('continues a truncated response and concatenates the parts', async () => {
    let chatCalls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        chatCalls++
        if (chatCalls === 1) {
          return stubResponse({ content: 'Part one, ', finish_reason: 'length' })
        }
        return stubResponse({ content: 'part two.' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:continuation',
    })

    const response = await agent.run('long question')

    expect(response.content).toBe('Part one, part two.')
    expect(response.continuationRetries).toBe(1)
    expect(response.turns).toBe(2)

    // The continue prompt was injected between the two parts
    const messages = agent.getContext().messages
    const continuePrompt = messages.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('Continue exactly where you left off'),
    )
    expect(continuePrompt).toBeDefined()
  })

  test('gives up continuing after the retry limit', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        return stubResponse({ content: 'X', finish_reason: 'length' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:continuation-limit',
    })

    const response = await agent.run('question')

    // 3 retries accumulate three X's, the 4th truncated response is accepted
    expect(response.content).toBe('XXXX')
    expect(response.continuationRetries).toBe(3)
  })
})

describe('AgentLoop post-response validation', () => {
  test('retries once with feedback when validation fails', async () => {
    let chatCalls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        chatCalls++
        return stubResponse({ content: chatCalls === 1 ? 'BAD' : 'GOOD' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:validation',
    })

    const validated: string[] = []
    const response = await agent.run('question', {
      events: {
        onPostResponseValidation: (content) => {
          validated.push(content)
          return content === 'BAD'
            ? { valid: false, feedback: 'No placeholders allowed' }
            : { valid: true }
        },
      },
    })

    expect(response.content).toBe('GOOD')
    expect(response.turns).toBe(2)
    // Validation only runs once — the retry response is accepted as-is
    expect(validated).toEqual(['BAD'])

    const feedbackMessage = agent
      .getContext()
      .messages.find(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.includes('[Validation failed]: No placeholders allowed'),
      )
    expect(feedbackMessage).toBeDefined()
  })
})

describe('AgentLoop planning mode', () => {
  test('returns a plan without offering tools', async () => {
    const toolsOffered: number[] = []
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        toolsOffered.push(req.tools?.length ?? 0)
        return stubResponse({ content: '1. step one\n2. step two' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:planning',
    })

    const response = await agent.run('build the thing', { planningMode: true })

    expect(response.isPlan).toBe(true)
    expect(response.content).toBe('1. step one\n2. step two')
    expect(response.turns).toBe(1)
    expect(toolsOffered).toEqual([0])

    const userMessage = agent.getContext().messages.find((m) => m.role === 'user')
    expect(userMessage?.content).toContain('[PLANNING MODE]')
    expect(userMessage?.content).toContain('build the thing')
  })
})

describe('AgentLoop token budget', () => {
  test('warns and injects a wrap-up notice when budget goes critical', async () => {
    const contextLength = makeConfig(makeWorkspace()).local.contextLength
    let chatCalls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        chatCalls++
        if (chatCalls === 1) {
          return stubResponse({
            tool_calls: [{ id: 'call_1', name: 'noop', arguments: {} }],
            finish_reason: 'tool_calls',
            usage: { input_tokens: Math.ceil(contextLength * 0.95), output_tokens: 5 },
          })
        }
        return stubResponse({ content: 'wrapped up' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:budget',
    })

    const warnings: string[] = []
    const response = await agent.run('go', {
      events: {
        onTokenBudgetWarning: (level) => {
          warnings.push(level)
        },
      },
    })

    expect(response.content).toBe('wrapped up')
    expect(warnings).toContain('critical')

    const wrapUp = agent
      .getContext()
      .messages.find(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.includes('Context window is nearly full'),
      )
    expect(wrapUp).toBeDefined()
  })
})
