/**
 * run() admits one run at a time per loop.
 *
 * Chat transports dispatch each message without awaiting the previous turn (a reply to a parked
 * report ask has to get through), so two runs can be started on one loop at once. They must not
 * interleave turns in the shared context, and the first to finish must not clear the second's
 * handle for interrupt()/inject(). Model: formal/ChatTurns.tla (OneRunPerLoop).
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

function lastUserText(req: ChatRequest): string {
  const users = req.messages.filter((m) => m.role === 'user')
  const last = users[users.length - 1]
  return typeof last?.content === 'string' ? last.content : ''
}

describe('run serialization', () => {
  test('a second run waits for the first instead of interleaving turns', async () => {
    const seen: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        seen.push(lastUserText(req))
        await Bun.sleep(5)
        inFlight--
        return stubResponse({ content: `re: ${lastUserText(req)}` })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:serial',
    })

    const [a, b] = await Promise.all([agent.run('first'), agent.run('second')])
    expect(a.content).toBe('re: first')
    expect(b.content).toBe('re: second')
    expect(maxInFlight).toBe(1)
    expect(seen).toEqual(['first', 'second'])
    // The transcript reads as two whole exchanges, in order.
    const roles = agent.getContext().messages.map((m) => `${m.role}:${m.content}`)
    expect(roles).toEqual([
      'user:first',
      'assistant:re: first',
      'user:second',
      'assistant:re: second',
    ])
  })

  test('the queued run is still interruptible after the first one ends', async () => {
    let agent: AgentLoop | undefined
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        n++
        if (lastUserText(req) === 'first') return stubResponse({ content: 'ok' })
        // The second run: interrupt it from outside on its second turn.
        if (n === 3) expect(agent?.interrupt()).toBe(true)
        return stubResponse({
          tool_calls: [{ id: `c${n}`, name: 'noop', arguments: { n } }],
          finish_reason: 'tool_calls',
        })
      },
    }
    agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:serial-interrupt',
    })

    const [, second] = await Promise.all([agent.run('first'), agent.run('second', { maxTurns: 8 })])
    expect(second.aborted).toBe(true)
    expect(agent.isRunning()).toBe(false)
  })

  test('a failed run does not block the next one', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        if (lastUserText(req) === 'one') throw new Error('boom')
        return stubResponse({ content: 'fine' })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:serial-error',
    })

    const [a, b] = await Promise.allSettled([agent.run('one'), agent.run('two')])
    expect(a.status).toBe('rejected')
    expect(b.status === 'fulfilled' && b.value.content).toBe('fine')
  })
})
