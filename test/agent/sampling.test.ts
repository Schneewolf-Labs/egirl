/**
 * Client sampling (the OpenAI-compatible surface) reaches every model call of a run, and a
 * client max_tokens caps the answer instead of being stitched past by continuations.
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

function makeAgent(provider: LLMProvider, sessionId: string): AgentLoop {
  return new AgentLoop({
    config: makeConfig(makeWorkspace()),
    toolExecutor: makeExecutorWithNoop(),
    localProvider: provider,
    sessionId,
  })
}

describe('per-request sampling', () => {
  test('reaches the tool-call turn and the answer turn alike', async () => {
    const seen: ChatRequest['sampling'][] = []
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        seen.push(req.sampling)
        return seen.length === 1
          ? stubResponse({ tool_calls: [{ id: 'c1', name: 'noop', arguments: {} }] })
          : stubResponse({ content: 'done' })
      },
    }
    const sampling = { temperature: 0.2, top_p: 0.9, seed: 7 }
    const res = await makeAgent(provider, 'test:sampling-all').run('go', { sampling })
    expect(res.content).toBe('done')
    expect(seen).toEqual([sampling, sampling])
  })

  test('without sampling the provider gets none', async () => {
    let seen: ChatRequest['sampling'] | 'unset' = 'unset'
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        seen = req.sampling
        return stubResponse({ content: 'hi' })
      },
    }
    await makeAgent(provider, 'test:sampling-none').run('go')
    expect(seen).toBeUndefined()
  })

  test('max_tokens turns off continuation and reports the answer as truncated', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        calls++
        return stubResponse({ content: 'cut off mid', finish_reason: 'length' })
      },
    }
    const res = await makeAgent(provider, 'test:sampling-cap').run('long', {
      sampling: { max_tokens: 3 },
    })
    expect(calls).toBe(1)
    expect(res.content).toBe('cut off mid')
    expect(res.truncated).toBe(true)
  })

  test('without a client cap a truncated answer is still continued', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        calls++
        return calls === 1
          ? stubResponse({ content: 'part one ', finish_reason: 'length' })
          : stubResponse({ content: 'part two' })
      },
    }
    const res = await makeAgent(provider, 'test:sampling-continue').run('long')
    expect(res.content).toBe('part one part two')
    expect(res.truncated).toBeUndefined()
  })
})
