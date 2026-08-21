/**
 * Wall-clock wrap-up warning — the time-based consolidation trigger.
 *
 * As a run nears its hard deadline (a task timeout), the loop injects ONE message telling the
 * agent to stop new work, write its notes, and conclude — turning a mid-thought guillotine into
 * a self-directed wind-down. These pin that it fires once, only inside the margin, and not at all
 * without a deadline.
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

const WRAPUP = 'nearly this round'

/** Keeps calling a tool so the loop runs many turns; records each request. */
function loopingProvider(seen: string[]): LLMProvider {
  let n = 0
  return {
    name: 'stub',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      seen.push(JSON.stringify(req.messages))
      n++
      if (n >= 6) return stubResponse({ content: 'done' })
      return stubResponse({
        tool_calls: [{ id: `c${n}`, name: 'noop', arguments: { n } }],
        finish_reason: 'tool_calls',
      })
    },
  }
}

function makeAgent(provider: LLMProvider, sessionId: string): AgentLoop {
  return new AgentLoop({
    config: makeConfig(makeWorkspace()),
    toolExecutor: makeExecutorWithNoop(),
    localProvider: provider,
    sessionId,
  })
}

describe('wall-clock wrap-up warning', () => {
  test('fires once when already inside the deadline margin', async () => {
    const seen: string[] = []
    const agent = makeAgent(loopingProvider(seen), 'test:wrapup')
    // Deadline is 1 minute out with a 10-minute margin — so every turn is "inside" the margin,
    // but the one-time guard must still inject it exactly once.
    await agent.run('go', { maxTurns: 6, deadline: Date.now() + 60_000, wrapupMarginMs: 600_000 })

    const withWarning = seen.filter((s) => s.includes(WRAPUP)).length
    // Counts requests that carry the warning; once injected it stays in context, so it appears
    // in that request and every one after — but it must be added a single time.
    const firstIdx = seen.findIndex((s) => s.includes(WRAPUP))
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    // Injected once: the number of NEW appearances (first request that has it) is one, and it is
    // present from there on. Verify it is not injected twice by checking the count only grows by
    // context accumulation, never resets — i.e. every request from firstIdx on has exactly one.
    for (let i = firstIdx; i < seen.length; i++) {
      const occurrences = seen[i]?.split(WRAPUP).length ?? 1
      expect(occurrences - 1).toBe(1)
    }
    expect(withWarning).toBeGreaterThan(0)
  })

  test('does not fire when the deadline is far off', async () => {
    const seen: string[] = []
    const agent = makeAgent(loopingProvider(seen), 'test:wrapup-far')
    // Deadline an hour out, 7-minute margin — never inside the window during a fast test run.
    await agent.run('go', {
      maxTurns: 6,
      deadline: Date.now() + 3_600_000,
      wrapupMarginMs: 420_000,
    })
    expect(seen.some((s) => s.includes(WRAPUP))).toBe(false)
  })

  test('does not fire without a deadline', async () => {
    const seen: string[] = []
    const agent = makeAgent(loopingProvider(seen), 'test:wrapup-none')
    await agent.run('go', { maxTurns: 6 })
    expect(seen.some((s) => s.includes(WRAPUP))).toBe(false)
  })
})
