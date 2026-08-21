/**
 * Unbounded run mode.
 *
 * With `unbounded: true` the turn cap stops being the terminator — the run ends on a mechanical
 * failure, a semantic report, or its own conclusion. These check that maxTurns no longer bounds
 * it and that the failure detectors still do (an unbounded run must not be an un-stoppable one).
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

describe('unbounded run', () => {
  test('ignores a low maxTurns and runs until the model concludes', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        // 20 tool turns (well past maxTurns:3), each with distinct args so no spiral, then done.
        if (calls > 20) return stubResponse({ content: 'concluded' })
        return stubResponse({
          tool_calls: [{ id: `c${calls}`, name: 'noop', arguments: { n: calls } }],
          finish_reason: 'tool_calls',
        })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:unbounded',
    })
    const response = await agent.run('go', { maxTurns: 3, unbounded: true })
    // A bounded run would have force-finalized at turn 3; unbounded ran all 21.
    expect(calls).toBeGreaterThan(20)
    expect(response.content).toBe('concluded')
  })

  test('a spiral still stops an unbounded run', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        // The same call forever — unbounded must not mean unstoppable.
        return stubResponse({
          content: 'looping',
          tool_calls: [{ id: `c${calls}`, name: 'noop', arguments: { same: 1 } }],
          finish_reason: 'tool_calls',
        })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:unbounded-spiral',
    })
    const response = await agent.run('go', { unbounded: true })
    // Caught by the spiral guard on the third identical turn, nowhere near the safety ceiling.
    expect(calls).toBe(3)
    expect(response.content).toContain('[Run aborted')
  })
})
