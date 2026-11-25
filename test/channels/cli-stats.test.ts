/**
 * Quick-glance run numbers on the status line: step, tokens, rate, context, queue.
 */

import { describe, expect, test } from 'bun:test'
import type { ModelTurn } from '../../src/agent/events'
import { createRunStats, withStats } from '../../src/channels/cli-stats'

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const strip = (s: string): string => s.replace(ANSI, '')

const turn = (inputTokens: number): ModelTurn =>
  ({
    messages: [],
    tools: [],
    response: { usage: { input_tokens: inputTokens, output_tokens: 1 } },
  }) as unknown as ModelTurn

function setup(over: { enabled?: boolean; queued?: number; length?: number } = {}) {
  let t = 0
  const stats = createRunStats({
    maxTurns: 10,
    contextLength: () => over.length,
    queued: () => over.queued ?? 0,
    isEnabled: () => over.enabled ?? true,
    now: () => t,
  })
  return { stats, advance: (ms: number) => (t += ms), render: () => strip(stats.render()) }
}

describe('createRunStats', () => {
  test('starts at step 1 with nothing else to say', () => {
    expect(setup().render()).toBe('step 1/10')
  })

  test('counts streamed tokens and their rate over the current step', () => {
    const { stats, advance, render } = setup()
    stats.events.onThinkingToken?.('a')
    advance(2000)
    for (let i = 0; i < 79; i++) stats.events.onToken?.('b')
    expect(render()).toBe('step 1/10 · ↓80 40/s')
  })

  test('a finished step moves the step on, resets the rate, and gives the context fill', () => {
    const { stats, render } = { ...setup({ length: 1000 }) }
    stats.events.onToken?.('a')
    stats.events.onModelTurn?.(turn(630))
    expect(render()).toBe('step 2/10 · ↓1 · ctx 63%')
  })

  test('shows the queue, never passes the cap, and says nothing when off', () => {
    const { stats, render } = setup({ queued: 2 })
    for (let i = 0; i < 12; i++) stats.events.onModelTurn?.(turn(1))
    expect(render()).toBe('step 10/10 · 2 queued')
    expect(setup({ enabled: false }).render()).toBe('')
  })
})

describe('withStats', () => {
  test('feeds both handlers, the renderer first', () => {
    const order: string[] = []
    const { stats } = setup()
    const merged = withStats(
      { onToken: () => order.push('renderer') },
      {
        ...stats,
        events: { onToken: () => order.push('stats') },
      },
    )
    merged.onToken?.('x')
    expect(order).toEqual(['renderer', 'stats'])
  })
})
