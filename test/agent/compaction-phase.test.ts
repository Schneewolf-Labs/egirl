/**
 * A run held up by a still-running compaction says so before its first model call.
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

function agent(id: string): AgentLoop {
  const provider: LLMProvider = {
    name: 'stub',
    async chat(): Promise<ChatResponse> {
      return stubResponse({ content: 'ok', usage: { input_tokens: 10, output_tokens: 2 } })
    },
  }
  return new AgentLoop({
    config: makeConfig(makeWorkspace()),
    toolExecutor: makeExecutorWithNoop(),
    localProvider: provider,
    sessionId: id,
  })
}

describe('compacting phase', () => {
  test('a run that waits on compaction reports compacting, then waiting', async () => {
    const a = agent('test:phase-compacting')
    for (const msg of ['one', 'two', 'three']) await a.run(msg)
    // Not awaited past scheduling: the summary is still in flight when the next run starts.
    await a.compactNow()
    const phases: string[] = []
    await a.run('four', { events: { onPhase: (p) => phases.push(p) } })
    expect(phases).toEqual(['compacting', 'waiting'])
  })

  test('a run with nothing to wait on reports no phase', async () => {
    const a = agent('test:phase-none')
    const phases: string[] = []
    await a.run('hi', { events: { onPhase: (p) => phases.push(p) } })
    expect(phases).toEqual([])
  })
})
