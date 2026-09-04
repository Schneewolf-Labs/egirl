/**
 * Every run narrates on the session bus, whether or not the caller attached events. This is
 * what lets a task run nobody is watching be watched later, and what the journal records.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import {
  isRunning,
  resetSessionEvents,
  runningLoop,
  type SessionEvent,
  subscribe,
} from '../../src/agent/session-events'
import type { ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

function makeAgent(provider: LLMProvider, sessionId: string): AgentLoop {
  return new AgentLoop({
    config: makeConfig(makeWorkspace()),
    toolExecutor: makeExecutorWithNoop(),
    localProvider: provider,
    sessionId,
  })
}

describe('a run publishes on the session bus', () => {
  afterEach(() => resetSessionEvents())

  test('with no caller events: run_start, turns, tools, run_end -- and the loop handle', async () => {
    let n = 0
    let liveDuringRun: AgentLoop | undefined
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        n++
        liveDuringRun = runningLoop('test:bus')
        if (n >= 2) return stubResponse({ content: 'done' })
        return stubResponse({
          tool_calls: [{ id: 'c1', name: 'noop', arguments: {} }],
          finish_reason: 'tool_calls',
        })
      },
    }
    const agent = makeAgent(provider, 'test:bus')
    const events: SessionEvent[] = []
    subscribe('test:bus', (e) => events.push(e))

    const result = await agent.run('go', { maxTurns: 4 })
    expect(result.content).toBe('done')
    expect(liveDuringRun).toBe(agent)
    expect(isRunning('test:bus')).toBe(false)

    const kinds = events.map((e) => e.t)
    expect(kinds[0]).toBe('run_start')
    expect(kinds[kinds.length - 1]).toBe('run_end')
    expect(kinds).toContain('turn')
    expect(kinds).toContain('tool')
    expect(kinds).toContain('tool_done')
    const end = events[events.length - 1]
    if (end?.t !== 'run_end') throw new Error('expected run_end')
    expect(end.v.content).toBe('done')
    expect(end.v.turns).toBe(2)
    const toolDone = events.find((e) => e.t === 'tool_done')
    if (toolDone?.t !== 'tool_done') throw new Error('expected tool_done')
    expect(toolDone.v.name).toBe('noop')
  })

  test('a provider failure ends the run with error, and the run is no longer live', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        throw new Error('server went away')
      },
    }
    const agent = makeAgent(provider, 'test:bus-error')
    const events: SessionEvent[] = []
    subscribe('test:bus-error', (e) => events.push(e))
    await expect(agent.run('go')).rejects.toThrow('server went away')
    const last = events[events.length - 1]
    expect(last).toEqual({ t: 'error', v: 'server went away' })
    expect(isRunning('test:bus-error')).toBe(false)
  })

  test('caller events still fire alongside the bus', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req): Promise<ChatResponse> {
        req.onToken?.('hel')
        req.onToken?.('lo')
        return stubResponse({ content: 'hello' })
      },
    }
    const agent = makeAgent(provider, 'test:bus-both')
    const bus: string[] = []
    const caller: string[] = []
    subscribe('test:bus-both', (e) => {
      if (e.t === 'token') bus.push(e.v)
    })
    await agent.run('go', { events: { onToken: (t) => caller.push(t) } })
    expect(bus).toEqual(['hel', 'lo'])
    expect(caller).toEqual(['hel', 'lo'])
  })
})
