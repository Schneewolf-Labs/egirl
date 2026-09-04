/**
 * The session event bus: the one registry of live runs and their narration.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentLoop } from '../../src/agent/loop'
import {
  anyRunning,
  endRun,
  isRunning,
  publish,
  resetSessionEvents,
  runningLoop,
  runningSessions,
  type SessionEvent,
  startRun,
  subscribe,
  subscribeAll,
} from '../../src/agent/session-events'

const loop = {} as AgentLoop
const ended: Extract<SessionEvent, { t: 'run_end' }> = {
  t: 'run_end',
  v: {
    content: 'ok',
    input_tokens: 1,
    output_tokens: 1,
    turns: 1,
    duration_ms: 5,
    aborted: false,
    awaiting: false,
  },
}

describe('session event bus', () => {
  afterEach(() => resetSessionEvents())

  test('a run is live from start to end, and the loop handle is reachable by session id', () => {
    expect(isRunning('s')).toBe(false)
    startRun('s', loop, 'hi')
    expect(isRunning('s')).toBe(true)
    expect(anyRunning()).toBe(true)
    expect(runningSessions()).toEqual(['s'])
    expect(runningLoop('s')).toBe(loop)
    endRun('s', ended)
    expect(isRunning('s')).toBe(false)
    expect(anyRunning()).toBe(false)
    expect(runningLoop('s')).toBeUndefined()
  })

  test('subscribers see their session only; subscribeAll sees every session', () => {
    const mine: SessionEvent[] = []
    const all: Array<[string, SessionEvent]> = []
    const off = subscribe('a', (e) => mine.push(e))
    subscribeAll((id, e) => all.push([id, e]))
    publish('a', { t: 'token', v: 'x' })
    publish('b', { t: 'token', v: 'y' })
    expect(mine).toEqual([{ t: 'token', v: 'x' }])
    expect(all.map(([id]) => id)).toEqual(['a', 'b'])
    off()
    publish('a', { t: 'token', v: 'z' })
    expect(mine).toHaveLength(1)
  })

  test('the running set is cleared before run_end reaches subscribers', () => {
    // A subscriber that checks isRunning on run_end must not see the run it was just told is
    // over -- the SSE route closes on this event and the picker reads busy from the same set.
    let liveOnEnd: boolean | undefined
    startRun('s', loop, 'hi')
    subscribe('s', (e) => {
      if (e.t === 'run_end') liveOnEnd = isRunning('s')
    })
    endRun('s', ended)
    expect(liveOnEnd).toBe(false)
  })

  test('a throwing subscriber does not stop delivery to the others', () => {
    const seen: string[] = []
    subscribe('s', () => {
      throw new Error('observer bug')
    })
    subscribe('s', (e) => seen.push(e.t))
    expect(() => publish('s', { t: 'token', v: 'x' })).not.toThrow()
    expect(seen).toEqual(['token'])
  })
})
