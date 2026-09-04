/**
 * Response-contract invariants of AgentLoop.run — the assertions callers build on.
 *
 * Every channel (CLI, Discord, API, task runner) consumes AgentResponse and isRunning()
 * without knowing the loop internals. These pin the parts of that contract not covered
 * elsewhere: the default turn cap, usage accounting across turns, the awaitingInput
 * relay from a tool result, the forced-final fallback text when even the wrap-up
 * inference fails, and the activeRun slot clearing on every exit path.
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { createToolExecutor } from '../../src/tools/executor'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

function makeAgent(provider: LLMProvider, sessionId: string): AgentLoop {
  return new AgentLoop({
    config: makeConfig(makeWorkspace()),
    toolExecutor: makeExecutorWithNoop(),
    localProvider: provider,
    sessionId,
  })
}

describe('default turn cap', () => {
  test('an unspecified maxTurns caps the run at 10 turns', async () => {
    let toolTurns = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        // While tools are offered, keep working — only the cap can end this run.
        if (req.tools && req.tools.length > 0) {
          toolTurns++
          return stubResponse({
            tool_calls: [{ id: `c${toolTurns}`, name: 'noop', arguments: { n: toolTurns } }],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'where I got to' })
      },
    }
    const agent = makeAgent(provider, 'test:default-cap')
    const result = await agent.run('go')

    expect(toolTurns).toBe(10)
    expect(result.turns).toBe(10)
    // The forced no-tools wrap-up supplies the final content.
    expect(result.content).toBe('where I got to')
  })
})

describe('usage accounting', () => {
  test('usage sums every inference and turns counts them', async () => {
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        n++
        if (n === 1) {
          return stubResponse({
            tool_calls: [{ id: 'c1', name: 'noop', arguments: {} }],
            finish_reason: 'tool_calls',
            usage: { input_tokens: 100, output_tokens: 10 },
          })
        }
        return stubResponse({ content: 'done', usage: { input_tokens: 200, output_tokens: 20 } })
      },
    }
    const agent = makeAgent(provider, 'test:usage')
    const result = await agent.run('go')

    expect(result.turns).toBe(2)
    expect(result.usage).toEqual({ input_tokens: 300, output_tokens: 30 })
    // A clean run reports none of the exceptional flags.
    expect(result.continuationRetries).toBeUndefined()
    expect(result.aborted).toBeUndefined()
    expect(result.awaitingInput).toBeUndefined()
  })
})

describe('awaitingInput relay', () => {
  test('a tool waiting on supervisor input surfaces on the response', async () => {
    const executor = createToolExecutor()
    executor.register({
      definition: {
        name: 'gated',
        description: 'needs approval',
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => ({
        success: false,
        output: 'Waiting for supervisor approval.',
        awaitingInput: true,
      }),
    })
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        n++
        if (n === 1) {
          return stubResponse({
            tool_calls: [{ id: 'c1', name: 'gated', arguments: {} }],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'paused for approval' })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: executor,
      localProvider: provider,
      sessionId: 'test:awaiting',
    })
    const result = await agent.run('go')
    expect(result.awaitingInput).toBe(true)
  })
})

describe('forced final response fallback', () => {
  test('a failing wrap-up inference still yields the fallback text, not a rejection', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        if (req.tools && req.tools.length > 0) {
          const id = crypto.randomUUID()
          return stubResponse({
            tool_calls: [{ id, name: 'noop', arguments: { id } }],
            finish_reason: 'tool_calls',
          })
        }
        // Auth-classified so the retry layer fails fast instead of backing off.
        throw new Error('401 unauthorized')
      },
    }
    const agent = makeAgent(provider, 'test:forced-final-error')
    const result = await agent.run('go', { maxTurns: 2 })
    expect(result.content).toBe('[Agent reached maximum turns without producing a final response]')
    expect(result.turns).toBe(2)
  })

  test('an empty wrap-up inference also yields the fallback text', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        if (req.tools && req.tools.length > 0) {
          const id = crypto.randomUUID()
          return stubResponse({
            tool_calls: [{ id, name: 'noop', arguments: { id } }],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: '   ' })
      },
    }
    const agent = makeAgent(provider, 'test:forced-final-empty')
    const result = await agent.run('go', { maxTurns: 2 })
    expect(result.content).toBe('[Agent reached maximum turns without producing a final response]')
  })
})

describe('isRunning lifecycle', () => {
  test('true while a run is in flight, false once it resolves', async () => {
    let agent: AgentLoop | undefined
    let seenMidRun: boolean | undefined
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        seenMidRun = agent?.isRunning()
        return stubResponse({ content: 'done' })
      },
    }
    agent = makeAgent(provider, 'test:running')
    expect(agent.isRunning()).toBe(false)
    await agent.run('go')
    expect(seenMidRun).toBe(true)
    expect(agent.isRunning()).toBe(false)
  })

  test('a provider error still clears the running state', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        // Auth-classified so the retry layer fails fast instead of backing off.
        throw new Error('401 unauthorized')
      },
    }
    const agent = makeAgent(provider, 'test:running-error')
    await expect(agent.run('go')).rejects.toThrow('unauthorized')
    // The activeRun slot is released in finally — a crashed run must not wedge
    // interrupt()/inject() into thinking something is still in flight.
    expect(agent.isRunning()).toBe(false)
    expect(agent.interrupt()).toBe(false)
  })
})

describe('thinking level', () => {
  function recordingProvider(seen: (string | undefined)[]): LLMProvider {
    return {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        seen.push(req.thinking?.level)
        return stubResponse({ content: 'ok' })
      },
    }
  }

  test('config off reaches the provider as an explicit off, not an omission', async () => {
    // Left unset, the chat template's own default decides -- and Qwen3's default is thinking on.
    const seen: (string | undefined)[] = []
    const agent = makeAgent(recordingProvider(seen), 'test:thinking-off')
    await agent.run('hi')
    expect(seen).toEqual(['off'])
    expect(agent.getThinking()).toEqual({ level: 'off', source: 'config' })
  })

  test('a session override wins over config until cleared', async () => {
    const seen: (string | undefined)[] = []
    const agent = makeAgent(recordingProvider(seen), 'test:thinking-session')
    agent.setThinking('high')
    expect(agent.getThinking()).toEqual({ level: 'high', source: 'session' })
    await agent.run('one')
    agent.setThinking(undefined)
    await agent.run('two')
    expect(seen).toEqual(['high', 'off'])
  })
})
