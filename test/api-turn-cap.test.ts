/**
 * The turn cap on chat runs.
 *
 * A /chat run (and a chat-channel run) sets no cap of its own, so it gets
 * `conversation.max_turns`; a /chat request can name its own. When the cap ends a run, the reply
 * is a forced no-tools summary that must not read like the model chose to stop, and the response
 * says so: `turn_limit_reached: true`, absent on a run that finished by itself.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentLoop, AgentLoopOptions } from '../src/agent'
import { AgentLoop as Loop } from '../src/agent/loop'
import { MAX_TURNS_SUMMARY_NUDGE } from '../src/agent/nudges'
import { resetSessionEvents } from '../src/agent/session-events'
import { CHAT_MAX_TURNS_LIMIT, startAPIServer } from '../src/api'
import type { ChatRequest, ChatResponse, LLMProvider } from '../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './agent/helpers'

/**
 * A model that never stops on its own: a fresh tool call every turn (distinct args, so no spiral
 * guard fires) until it is offered no tools -- the forced final response -- or `doneAfter` calls.
 */
function toolHappyProvider(doneAfter = Infinity): {
  provider: LLMProvider
  toolTurns: () => number
} {
  let calls = 0
  const provider: LLMProvider = {
    name: 'stub',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      if (!req.tools?.length)
        return stubResponse({ content: 'I ran out of steps before finishing.' })
      calls++
      if (calls > doneAfter) return stubResponse({ content: 'done' })
      return stubResponse({
        tool_calls: [{ id: `c${calls}`, name: 'noop', arguments: { n: calls } }],
        finish_reason: 'tool_calls',
      })
    },
  }
  return { provider, toolTurns: () => calls }
}

function realLoop(provider: LLMProvider, sessionId: string, maxTurns?: number): Loop {
  const config = makeConfig(makeWorkspace())
  if (maxTurns !== undefined) config.conversation.maxTurns = maxTurns
  return new Loop({
    config,
    toolExecutor: makeExecutorWithNoop(),
    localProvider: provider,
    sessionId,
  })
}

describe('turn cap on the agent loop', () => {
  beforeEach(() => resetSessionEvents())

  test('a run with no cap of its own uses conversation.max_turns', async () => {
    const { provider, toolTurns } = toolHappyProvider()
    const agent = realLoop(provider, 'test:cap-config', 4)
    const response = await agent.run('merge, test, push')
    expect(toolTurns()).toBe(4)
    expect(response.turnLimitReached).toBe(true)
    // The forced reply was asked to open by saying it ran out, not just to summarize.
    const nudge = agent.getContext().messages.find((m) => m.content === MAX_TURNS_SUMMARY_NUDGE)
    expect(nudge).toBeDefined()
    expect(MAX_TURNS_SUMMARY_NUDGE).toContain('ran out of steps')
  })

  test('the default stays 10 when the config does not set it', async () => {
    const { provider, toolTurns } = toolHappyProvider()
    // makeConfig leaves the key unset, like a config built before it existed.
    const agent = realLoop(provider, 'test:cap-default')
    const response = await agent.run('go')
    expect(toolTurns()).toBe(10)
    expect(response.turnLimitReached).toBe(true)
  })

  test('an explicit maxTurns beats the config', async () => {
    const { provider, toolTurns } = toolHappyProvider()
    const agent = realLoop(provider, 'test:cap-explicit', 4)
    await agent.run('go', { maxTurns: 2 })
    expect(toolTurns()).toBe(2)
  })

  test('a run that finishes by itself carries no flag', async () => {
    const { provider } = toolHappyProvider(2)
    const agent = realLoop(provider, 'test:cap-free', 4)
    const response = await agent.run('go')
    expect(response.content).toBe('done')
    expect(response.turnLimitReached).toBeUndefined()
  })
})

describe('turn cap on POST /chat', () => {
  const port = 3891
  const base = `http://127.0.0.1:${port}`
  let server: ReturnType<typeof startAPIServer>
  let seen: AgentLoopOptions[] = []
  let factory: (id: string) => AgentLoop

  /** Records the options each run was given; finishes at once unless told it hit the cap. */
  function recordingAgent(capped = false): AgentLoop {
    return {
      async run(_message: string, options: AgentLoopOptions = {}) {
        seen.push(options)
        return {
          content: 'ok',
          provider: 'test',
          usage: { input_tokens: 1, output_tokens: 1 },
          turns: 1,
          ...(capped && { turnLimitReached: true }),
        }
      },
      getContext: () => ({ sessionId: 'x', systemPrompt: '', messages: [] }),
    } as unknown as AgentLoop
  }

  async function chat(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  beforeEach(() => {
    resetSessionEvents()
    seen = []
    factory = () => recordingAgent()
    server = startAPIServer(
      { host: '127.0.0.1', port },
      { agentFactory: (id) => factory(id), agents: new Map() },
    )
  })

  afterEach(() => server.stop(true))

  test('without max_turns the run is left to the configured default', async () => {
    const res = await chat({ message: 'hi' })
    expect(res.status).toBe(200)
    expect(seen[0]?.maxTurns).toBeUndefined()
    const body = (await res.json()) as Record<string, unknown>
    expect('turn_limit_reached' in body).toBe(false)
  })

  test('a request max_turns is passed to the run', async () => {
    await chat({ message: 'hi', max_turns: 40 })
    expect(seen[0]?.maxTurns).toBe(40)
  })

  test('a request max_turns is clamped at the limit', async () => {
    await chat({ message: 'hi', max_turns: 100_000 })
    expect(seen[0]?.maxTurns).toBe(CHAT_MAX_TURNS_LIMIT)
  })

  test('a max_turns that is not a positive integer is rejected', async () => {
    for (const bad of [0, -3, 2.5, '20']) {
      const res = await chat({ message: 'hi', max_turns: bad })
      expect(res.status).toBe(400)
    }
    expect(seen).toHaveLength(0)
  })

  test('a capped run says so in the JSON response', async () => {
    factory = () => recordingAgent(true)
    const body = (await (await chat({ message: 'hi', session_id: 'api:capped' })).json()) as {
      turn_limit_reached?: boolean
    }
    expect(body.turn_limit_reached).toBe(true)
  })

  test('end to end: config default, request override, and the flag', async () => {
    // A real loop behind the factory, configured for 3 turns, with a model that never stops.
    let toolTurns = () => 0
    factory = (id) => {
      const p = toolHappyProvider()
      toolTurns = p.toolTurns
      return realLoop(p.provider, id, 3)
    }
    const capped = (await (await chat({ message: 'go', session_id: 'api:e2e-a' })).json()) as {
      turns: number
      content: string
      turn_limit_reached?: boolean
    }
    expect(toolTurns()).toBe(3)
    expect(capped.turn_limit_reached).toBe(true)
    expect(capped.content).toContain('ran out of steps')

    await chat({ message: 'go', session_id: 'api:e2e-b', max_turns: 6 })
    expect(toolTurns()).toBe(6)
  })

  test('the stream closes with a run_end frame carrying the flag', async () => {
    factory = (id) => realLoop(toolHappyProvider().provider, id, 2)
    const res = await chat({ message: 'go', session_id: 'web:capped', stream: true })
    const frames = (await res.text())
      .split('\n\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5).trim()) as { t: string; v?: Record<string, unknown> })
    const end = frames.find((f) => f.t === 'run_end')
    expect(end?.v?.turn_limit_reached).toBe(true)
  })
})
