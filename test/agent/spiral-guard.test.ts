/**
 * Cross-turn death-spiral detection.
 *
 * The line to hold: a real loop (same call, same args, again and again) is caught, while
 * genuine iterative work (same tool, different targets; a plan then its execution) is not.
 * The false positive here aborts productive runs, so the negatives matter as much as the
 * positives.
 */

import { describe, expect, test } from 'bun:test'
import { SpiralDetector, turnSignature } from '../../src/agent/spiral-guard'

describe('turnSignature', () => {
  test('same call with same args collides', () => {
    const a = turnSignature('let me check', [{ name: 'read_file', arguments: { path: 'a.md' } }])
    const b = turnSignature('let me check', [{ name: 'read_file', arguments: { path: 'a.md' } }])
    expect(a).toBe(b)
  })

  test('same tool, different args does NOT collide', () => {
    // Reading two different files is progress, not a loop.
    const a = turnSignature('', [{ name: 'read_file', arguments: { path: 'a.md' } }])
    const b = turnSignature('', [{ name: 'read_file', arguments: { path: 'b.md' } }])
    expect(a).not.toBe(b)
  })

  test('trivial wording drift in a restated plan still collides', () => {
    const a = turnSignature('First I  will parse the   header.')
    const b = turnSignature('First I will parse the header.')
    expect(a).toBe(b)
  })
})

describe('SpiralDetector', () => {
  test('three identical turns in a row trips it', () => {
    const d = new SpiralDetector()
    const sig = turnSignature('same', [{ name: 'x', arguments: { a: 1 } }])
    expect(d.record(sig)).toBe(false)
    expect(d.record(sig)).toBe(false)
    expect(d.record(sig)).toBe(true)
  })

  test('iterative work over distinct targets never trips it', () => {
    const d = new SpiralDetector()
    let tripped = false
    for (const path of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      tripped ||= d.record(turnSignature('reading', [{ name: 'read_file', arguments: { path } }]))
    }
    expect(tripped).toBe(false)
  })

  test('a repeat that falls outside the window does not accumulate', () => {
    // Same signature twice, then four different turns, then once more: never 3 within a window.
    const d = new SpiralDetector({ window: 4, threshold: 3 })
    const loop = turnSignature('stuck', [{ name: 'x', arguments: {} }])
    d.record(loop)
    d.record(loop)
    for (const n of [1, 2, 3, 4]) d.record(turnSignature(`work ${n}`))
    expect(d.record(loop)).toBe(false)
  })

  test('empty turns are ignored (they belong to the empty-response guard)', () => {
    const d = new SpiralDetector()
    expect(d.record(turnSignature(''))).toBe(false)
    expect(d.record(turnSignature(''))).toBe(false)
    expect(d.record(turnSignature(''))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration: the detector wired into the real AgentLoop.
// ---------------------------------------------------------------------------
import { AgentLoop } from '../../src/agent/loop'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

describe('AgentLoop aborts a spiraling run', () => {
  test('a model reissuing the same call forever is stopped, budget intact', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        // The same tool call with the same args, every single turn — a textbook spiral.
        return stubResponse({
          content: 'Let me check the header again.',
          tool_calls: [{ id: `c${calls}`, name: 'noop', arguments: { n: 1 } }],
          finish_reason: 'tool_calls',
        })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:spiral',
    })
    const response = await agent.run('do the thing', { maxTurns: 40 })
    // Caught on the third identical turn, not at the 40-turn ceiling.
    expect(calls).toBe(3)
    expect(response.content).toContain('[Run aborted: the agent began repeating')
  })

  test('genuine progress across turns runs to completion', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        // Distinct calls each turn, then a final answer — must NOT be mistaken for a spiral.
        if (calls <= 3) {
          return stubResponse({
            content: `step ${calls}`,
            tool_calls: [{ id: `c${calls}`, name: 'noop', arguments: { n: calls } }],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'done, all three steps complete' })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:progress',
    })
    const response = await agent.run('do the thing', { maxTurns: 40 })
    expect(response.content).toBe('done, all three steps complete')
  })
})

// ---------------------------------------------------------------------------
// Reasoning-loop detection (within-inference thinking spiral).
// ---------------------------------------------------------------------------
import { isReasoningLooping } from '../../src/agent/spiral-guard'

describe('isReasoningLooping', () => {
  test('a thinking block that loops on one fragment is caught', () => {
    const loop = 'Let me reconsider the RFH header offset again to be certain of the layout. '
    expect(isReasoningLooping(loop.repeat(30))).toBe(true)
  })

  test('varied genuine reasoning is not a loop', () => {
    const real = Array.from(
      { length: 25 },
      (_, i) => `At offset ${i * 4} the field is a ${i % 2 ? 'length' : 'pointer'} of ${i} bytes.`,
    ).join(' ')
    expect(isReasoningLooping(real)).toBe(false)
  })

  test('absent or short thinking is never a loop', () => {
    expect(isReasoningLooping(undefined)).toBe(false)
    expect(isReasoningLooping('hmm, let me think')).toBe(false)
  })
})

describe('turnSignature reasoning fingerprint', () => {
  test('same content + calls but different thinking do not collide', () => {
    const a = turnSignature(
      'checking',
      [{ name: 'x', arguments: {} }],
      'because the header is 7 bytes',
    )
    const b = turnSignature(
      'checking',
      [{ name: 'x', arguments: {} }],
      'because the offset is wrong',
    )
    expect(a).not.toBe(b)
  })

  test('identical reasoning across turns collides even with drifting content', () => {
    const think = 'The type-1 payload must be RLE because the zeros cluster at the start.'
    const a = turnSignature('step one', [{ name: 'x', arguments: {} }], think)
    const b = turnSignature('step one', [{ name: 'x', arguments: {} }], think)
    expect(a).toBe(b)
  })

  test('empty turn signature is still ignored by the detector', () => {
    const d = new SpiralDetector()
    const empty = turnSignature('', undefined, '')
    expect(d.record(empty)).toBe(false)
    expect(d.record(empty)).toBe(false)
    expect(d.record(empty)).toBe(false)
  })
})

describe('AgentLoop aborts a within-turn reasoning loop', () => {
  test('a looping thinking block ends the run on the first offending turn', async () => {
    const loop = 'I should re-examine the RFD header once more to be absolutely sure. '
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        return stubResponse({ content: 'still working', thinking: loop.repeat(30) })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:reasoning-loop',
    })
    const response = await agent.run('analyze it', { maxTurns: 40 })
    expect(response.content).toContain(
      "[Run aborted: the agent's reasoning entered a repetition loop.]",
    )
  })
})
