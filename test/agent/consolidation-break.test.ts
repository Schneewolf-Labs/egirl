/**
 * Consolidation break — the recurring checkpoint nudge.
 *
 * Every `consolidationInterval` turns the loop injects one system turn telling the agent to
 * externalize what it has learned before continuing. These pin the timing (fires on the
 * interval, not turn 1) and that it's genuinely off by default.
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

/** Provider that keeps calling a tool so the loop runs many turns, recording each request. */
function loopingProvider(seen: string[]): LLMProvider {
  let n = 0
  return {
    name: 'stub',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      seen.push(JSON.stringify(req.messages))
      n++
      // Vary the args each turn so the spiral guard never trips; end after enough turns.
      if (n >= 8) return stubResponse({ content: 'done' })
      return stubResponse({
        tool_calls: [{ id: `c${n}`, name: 'noop', arguments: { n } }],
        finish_reason: 'tool_calls',
      })
    },
  }
}

const NUDGE = 'Pause new work and consolidate'

describe('consolidation break', () => {
  test('fires every N turns, never on turn 1', async () => {
    const seen: string[] = []
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: loopingProvider(seen),
      sessionId: 'test:break',
    })
    await agent.run('go', { maxTurns: 8, consolidationInterval: 3 })

    // The nudge is present in the request on the turn AFTER each interval boundary.
    const withNudge = seen.map((s) => s.includes(NUDGE))
    // Turn 1 request never has it.
    expect(withNudge[0]).toBe(false)
    // At least one later request carries it (turns 4 and 7 with interval 3).
    expect(withNudge.some((v, i) => v && i > 0)).toBe(true)
    // Count of injected nudges across the run matches the interval schedule (turns 4, 7).
    const injected = new Set<number>()
    seen.forEach((s, i) => {
      if (s.includes(NUDGE)) injected.add(i)
    })
    expect(injected.size).toBeGreaterThanOrEqual(2)
  })

  test('off by default: no nudge when interval is 0', async () => {
    const seen: string[] = []
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: loopingProvider(seen),
      sessionId: 'test:no-break',
    })
    await agent.run('go', { maxTurns: 8 })
    expect(seen.some((s) => s.includes(NUDGE))).toBe(false)
  })

  test('a per-run interval overrides the config default', async () => {
    const seen: string[] = []
    const cfg = makeConfig(makeWorkspace())
    cfg.conversation.consolidationInterval = 0 // config says off...
    const agent = new AgentLoop({
      config: cfg,
      toolExecutor: makeExecutorWithNoop(),
      localProvider: loopingProvider(seen),
      sessionId: 'test:override',
    })
    await agent.run('go', { maxTurns: 8, consolidationInterval: 2 }) // ...run turns it on
    expect(seen.some((s) => s.includes(NUDGE))).toBe(true)
  })
})

describe('context-pressure trigger', () => {
  test('a nearly-full context fires the break even off-interval', async () => {
    // Report input_tokens above 80% of the 32768 test context (>26214) so the context
    // trigger fires; interval is large so only context pressure can cause it.
    const seen: string[] = []
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        seen.push(JSON.stringify(req.messages))
        n++
        if (n >= 5)
          return stubResponse({ content: 'done', usage: { input_tokens: 30000, output_tokens: 1 } })
        return stubResponse({
          tool_calls: [{ id: `c${n}`, name: 'noop', arguments: { n } }],
          finish_reason: 'tool_calls',
          usage: { input_tokens: 30000, output_tokens: 1 },
        })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:ctx-pressure',
    })
    // interval 100 (never hits on turn count in a 5-turn run) — only context pressure can trigger.
    await agent.run('go', { maxTurns: 6, consolidationInterval: 100 })
    expect(seen.some((s) => s.includes('nearly full'))).toBe(true)
  })

  test('low context never fires the context trigger', async () => {
    const seen: string[] = []
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        seen.push(JSON.stringify(req.messages))
        n++
        if (n >= 5)
          return stubResponse({ content: 'done', usage: { input_tokens: 500, output_tokens: 1 } })
        return stubResponse({
          tool_calls: [{ id: `c${n}`, name: 'noop', arguments: { n } }],
          finish_reason: 'tool_calls',
          usage: { input_tokens: 500, output_tokens: 1 },
        })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:ctx-low',
    })
    await agent.run('go', { maxTurns: 6, consolidationInterval: 100 })
    expect(seen.some((s) => s.includes('nearly full'))).toBe(false)
  })
})
