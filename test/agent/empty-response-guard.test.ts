/**
 * Empty-response retries and the deterministic-empty cutoff.
 *
 * Ported from hermes-agent's empty_response_guard (NS-503). The distinction that matters:
 * an attempt with output_tokens === 0 produced nothing at all -- twice in a row means the
 * prompt deterministically yields empty and further retries are burned prefill -- while an
 * attempt that GENERATED something (reasoning ate the budget, think-stripping ate the text)
 * may land differently under sampling and keeps its budget.
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

function agentWith(provider: LLMProvider, id: string): AgentLoop {
  return new AgentLoop({
    config: makeConfig(makeWorkspace()),
    toolExecutor: makeExecutorWithNoop(),
    localProvider: provider,
    sessionId: id,
  })
}

describe('empty-response guard', () => {
  test('a transient empty is retried and the retry answers', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        if (calls === 1) return stubResponse({ content: '' })
        return stubResponse({
          content: 'here after all',
          usage: { input_tokens: 10, output_tokens: 4 },
        })
      },
    }
    const response = await agentWith(provider, 'test:empty-transient').run('hi')
    expect(calls).toBe(2)
    expect(response.content).toBe('here after all')
  })

  test('two zero-output empties are deterministic: no third attempt', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        return stubResponse({ content: '', usage: { input_tokens: 10, output_tokens: 0 } })
      },
    }
    const response = await agentWith(provider, 'test:empty-deterministic').run('hi')
    // Original + one retry; the second zero-output attempt classifies as deterministic.
    expect(calls).toBe(2)
    expect(response.content).toBe('[The model returned an empty response.]')
  })

  test('generated-but-empty keeps the full budget', async () => {
    // output_tokens > 0 with no content: the reasoning-ate-the-budget shape. Sampling can
    // land differently, so both retries run.
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        return stubResponse({ content: '', usage: { input_tokens: 10, output_tokens: 900 } })
      },
    }
    await agentWith(provider, 'test:empty-generated').run('hi')
    expect(calls).toBe(3)
  })

  test('a normal response is untouched by the guard', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        return stubResponse({ content: 'plain answer' })
      },
    }
    const response = await agentWith(provider, 'test:empty-none').run('hi')
    expect(calls).toBe(1)
    expect(response.content).toBe('plain answer')
  })
})
