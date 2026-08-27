/**
 * Context-pressure consolidation is rate-limited to one break per interval window.
 *
 * A context that fills up tends to STAY full — every turn after the first crossing
 * would re-fire the pressure trigger and turn the checkpoint nudge into per-turn
 * nagging. The loop remembers the turn of the last context break and holds fire until
 * a full interval has passed, while the steady interval trigger keeps its own rhythm.
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

// The two triggers share one mechanism but produce distinguishable wording.
const PRESSURE_BREAK = 'about to be compacted'
const INTERVAL_BREAK = 'Pause new work and consolidate'

describe('context-pressure rate limit', () => {
  test('a sustained-high context fires one break per interval window, not every turn', async () => {
    // 28000/32768 ≈ 85%: above the 80% pressure threshold on every turn, below the 90%
    // critical-budget threshold whose separate wrap-up injection would muddy the count.
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        n++
        if (n >= 8)
          return stubResponse({
            content: 'done',
            usage: { input_tokens: 28000, output_tokens: 1 },
          })
        return stubResponse({
          tool_calls: [{ id: `c${n}`, name: 'noop', arguments: { n } }],
          finish_reason: 'tool_calls',
          usage: { input_tokens: 28000, output_tokens: 1 },
        })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:pressure-rate-limit',
    })
    await agent.run('go', { maxTurns: 20, consolidationInterval: 5 })

    const texts = agent
      .getContext()
      .messages.map((m) => (typeof m.content === 'string' ? m.content : ''))

    // Utilization is high from turn 2 through turn 8, yet the pressure break fires only
    // at turn 2 and again at turn 7 — the first turn a full interval after the last one.
    // Firing every turn would produce ~7 of these.
    expect(texts.filter((t) => t.includes(PRESSURE_BREAK)).length).toBe(2)
    // The steady interval trigger keeps its own schedule (turn 6) alongside.
    expect(texts.filter((t) => t.includes(INTERVAL_BREAK)).length).toBe(1)
  })
})
