/**
 * interrupt() and inject() — reaching into a running loop from outside.
 *
 * interrupt() aborts the in-flight run through the same signal path as a timeout; inject()
 * queues an operator message that is delivered at the top of the next turn, never spliced
 * between an assistant tool call and its results. Both return false when nothing is running,
 * so callers know to fall back to a normal chat message.
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

function makeAgent(provider: LLMProvider, sessionId: string): AgentLoop {
  return new AgentLoop({
    config: makeConfig(makeWorkspace()),
    toolExecutor: makeExecutorWithNoop(),
    localProvider: provider,
    sessionId,
  })
}

describe('interrupt', () => {
  test('aborts a run mid-flight', async () => {
    let agent: AgentLoop | undefined
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        n++
        // Interrupt from "outside" while the second turn is in flight.
        if (n === 2) agent?.interrupt()
        if (n >= 8) return stubResponse({ content: 'done' })
        return stubResponse({
          tool_calls: [{ id: `c${n}`, name: 'noop', arguments: { n } }],
          finish_reason: 'tool_calls',
        })
      },
    }
    agent = makeAgent(provider, 'test:interrupt')
    const result = await agent.run('go', { maxTurns: 8 })
    expect(result.aborted).toBe(true)
    expect(result.turns).toBeLessThan(8)
    expect(agent.isRunning()).toBe(false)
  })

  test('returns false when nothing is running', () => {
    const agent = makeAgent(
      {
        name: 'stub',
        async chat() {
          return stubResponse({ content: 'hi' })
        },
      },
      'test:idle',
    )
    expect(agent.interrupt()).toBe(false)
    expect(agent.inject('hello?')).toBe(false)
  })

  test('an external signal still aborts the run', async () => {
    const external = new AbortController()
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        n++
        if (n === 2) external.abort()
        if (n >= 8) return stubResponse({ content: 'done' })
        return stubResponse({
          tool_calls: [{ id: `c${n}`, name: 'noop', arguments: { n } }],
          finish_reason: 'tool_calls',
        })
      },
    }
    const agent = makeAgent(provider, 'test:external')
    const result = await agent.run('go', { maxTurns: 8, signal: external.signal })
    expect(result.aborted).toBe(true)
  })
})

describe('inject', () => {
  const NOTE = 'switch to the other binary'

  test('delivers the message at the next turn boundary, after tool results', async () => {
    let agent: AgentLoop | undefined
    const seen: Array<Array<{ role: string; content: unknown }>> = []
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        seen.push(req.messages.map((m) => ({ role: m.role, content: m.content })))
        n++
        if (n === 2) agent?.inject(NOTE)
        if (n >= 5) return stubResponse({ content: 'done' })
        return stubResponse({
          tool_calls: [{ id: `c${n}`, name: 'noop', arguments: { n } }],
          finish_reason: 'tool_calls',
        })
      },
    }
    agent = makeAgent(provider, 'test:inject')
    const result = await agent.run('go', { maxTurns: 8 })
    expect(result.aborted).toBeUndefined()

    const hasNote = (msgs: Array<{ content: unknown }>) =>
      msgs.some((m) => typeof m.content === 'string' && m.content.includes(NOTE))
    // Injected during turn 2's inference — absent from that request, present in the next.
    expect(hasNote(seen[1] ?? [])).toBe(false)
    const firstWith = seen.findIndex(hasNote)
    expect(firstWith).toBe(2)
    // Delivered at the turn boundary: it is the LAST message of that request — after turn 2's
    // tool results, never spliced between a tool call and its result.
    const request = seen[firstWith] ?? []
    const last = request[request.length - 1]
    expect(typeof last?.content === 'string' && last.content.includes(NOTE)).toBe(true)
    expect(last?.role).toBe('user')
    // And it stays in context for every later request.
    expect(hasNote(seen[seen.length - 1] ?? [])).toBe(true)
  })
})
