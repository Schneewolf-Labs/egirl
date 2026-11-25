/**
 * The waiting segment: the prompt's size, and how long the first token usually takes, while a
 * hosted API that sends nothing before its first token is working.
 */

import { describe, expect, test } from 'bun:test'
import type { ModelTurn } from '../../src/agent/events'
import { createWaitHistory, createWaitTracker } from '../../src/channels/cli-wait'

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const strip = (s: string): string => s.replace(ANSI, '')
const turn = (input: number) =>
  ({ response: { usage: { input_tokens: input, output_tokens: 1 } } }) as unknown as ModelTurn

function setup(initial?: number) {
  let t = 0
  const history = createWaitHistory()
  const make = () =>
    createWaitTracker({ history, initialPromptTokens: () => initial, now: () => t })
  return { history, make, advance: (ms: number) => (t += ms) }
}

describe('createWaitHistory', () => {
  test('is the median of the last few samples', () => {
    const h = createWaitHistory(3)
    expect(h.typical()).toBeUndefined()
    for (const ms of [100, 90_000, 20_000, 30_000, 25_000]) h.record(ms)
    expect(h.typical()).toBe(25_000)
  })
})

describe('createWaitTracker', () => {
  test('before any history: the prompt size alone', () => {
    const { make } = setup(82_000)
    expect(strip(make().render())).toBe('~82k prompt')
  })

  test('learns the first-token time and shows a bar against it on the next wait', () => {
    const { make, advance } = setup(82_000)
    const first = make()
    advance(30_000)
    first.events.onThinkingToken?.('x')
    expect(first.render()).toBe('')

    const second = make()
    advance(15_000)
    expect(strip(second.render())).toBe('~82k prompt · usually ~30s ▰▰▰▰▱▱▱▱')
    advance(40_000)
    expect(strip(second.render())).toContain('slower than usual (usually ~30s)')
  })

  test('a tool finishing starts a new wait, with the size of the prompt just measured', () => {
    const { make, advance } = setup()
    const w = make()
    w.events.onToken?.('x')
    w.events.onModelTurn?.(turn(41_000))
    expect(w.render()).toBe('')
    w.events.onToolCallComplete?.('c1', 'noop', { success: true, output: 'ok' })
    advance(10)
    expect(strip(w.render())).toBe('~41k prompt')
  })

  test('prefill progress ends the wait: the real bar takes over', () => {
    const { make } = setup(1000)
    const w = make()
    w.events.onPromptProgress?.({ processed: 10, total: 100 })
    expect(w.render()).toBe('')
  })
})
