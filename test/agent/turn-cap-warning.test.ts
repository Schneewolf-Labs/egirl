/**
 * The warning a few steps before the turn cap.
 *
 * Before it, the first a run heard of the cap was the forced summary at the end; an agent that
 * was mid-way through writing a file across steps left a placeholder behind.
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import { TURN_CAP_WARNING_STEPS, turnCapNudge, turnCapWarningSteps } from '../../src/agent/nudges'
import { capNote, createRunSignals } from '../../src/operator/run-signals'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

const WARNING = 'steps left in this run'

/** Calls a tool every step, so only the cap ends the run; records each request. */
function busyProvider(seen: string[]): LLMProvider {
  let n = 0
  return {
    name: 'stub',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      seen.push(JSON.stringify(req.messages))
      n++
      return stubResponse({
        tool_calls: [{ id: `c${n}`, name: 'noop', arguments: { n } }],
        finish_reason: 'tool_calls',
      })
    },
  }
}

function agent(seen: string[], id: string): AgentLoop {
  return new AgentLoop({
    config: makeConfig(makeWorkspace()),
    toolExecutor: makeExecutorWithNoop(),
    localProvider: busyProvider(seen),
    sessionId: id,
  })
}

/** Index of the first request that carries the warning, or -1. */
const firstWarned = (seen: string[]): number => seen.findIndex((s) => s.includes(WARNING))

describe('turnCapNudge', () => {
  test('fires on exactly one step, the one with three steps left', () => {
    const fired = Array.from({ length: 10 }, (_, i) => turnCapNudge(i + 1, 10))
    expect(fired.filter(Boolean)).toHaveLength(1)
    expect(fired[10 - TURN_CAP_WARNING_STEPS]).toContain('3 steps left')
    expect(fired[10 - TURN_CAP_WARNING_STEPS]).toContain('stops after step 10')
  })

  test('a longer cap gets a tenth of it as notice', () => {
    expect(turnCapWarningSteps(10)).toBe(3)
    expect(turnCapWarningSteps(40)).toBe(4)
    expect(turnCapWarningSteps(64)).toBe(7)
    const fired = Array.from({ length: 40 }, (_, i) => turnCapNudge(i + 1, 40))
    expect(fired.filter(Boolean)).toHaveLength(1)
    expect(fired[36]).toContain('4 steps left')
  })

  test('the warning is a checklist: finish, commit, notes, an honest reply', () => {
    const text = turnCapNudge(8, 10) ?? ''
    expect(text).toContain('never leave one half-written')
    expect(text).toContain('commit the finished work')
    expect(text).toContain('in your notes')
    expect(text).toContain('done and checked')
  })

  test('a short run gets no warning', () => {
    for (let turn = 1; turn <= 5; turn++) expect(turnCapNudge(turn, 5)).toBeUndefined()
  })
})

describe('in the loop', () => {
  test('a run that would hit its cap is warned three steps before it, once', async () => {
    const seen: string[] = []
    const response = await agent(seen, 'test:cap-warn').run('go', { maxTurns: 10 })
    expect(response.turnLimitReached).toBe(true)
    // Step 8 of 10 is the first request that carries it; it stays in context after that.
    expect(firstWarned(seen)).toBe(7)
    const occurrences = (seen.at(-1) ?? '').split(WARNING).length - 1
    expect(occurrences).toBe(1)
  })

  test('an unbounded run is not told about its safety ceiling', async () => {
    const seen: string[] = []
    const controller = new AbortController()
    // Stop it well short of the ceiling, from inside the provider: a timer would depend on the
    // loop yielding to the event loop, which a stub that answers at once never makes it do.
    const provider = busyProvider(seen)
    const chat = provider.chat.bind(provider)
    provider.chat = async (req) => {
      if (seen.length >= 30) controller.abort()
      return chat(req)
    }
    const a = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:cap-warn-unbounded',
    })
    await a.run('go', { unbounded: true, signal: controller.signal })
    expect(seen.length).toBeGreaterThanOrEqual(30)
    expect(firstWarned(seen)).toBe(-1)
  })
})

describe('on a hosted operator (Claude, Codex)', () => {
  test('the checklist rides on the first tool result inside the window, once', () => {
    const signals = createRunSignals()
    const notes: (string | undefined)[] = []
    for (let step = 1; step <= 40; step++) {
      signals.steps = step
      notes.push(capNote(signals, 40))
    }
    expect(notes.filter(Boolean)).toHaveLength(1)
    // Step 37 is the first with fewer than four steps after it.
    expect(notes[36]).toContain('3 steps left')
  })

  test('an unbounded run or a short cap gets none', () => {
    const signals = createRunSignals()
    signals.steps = 9_999
    expect(capNote(signals, undefined)).toBeUndefined()
    signals.steps = 5
    expect(capNote(signals, 5)).toBeUndefined()
  })
})
