import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentLoop } from '../src/agent'
import { endRun, publish, resetSessionEvents, startRun } from '../src/agent/session-events'
import type { AgentLoopOptions } from '../src/agent/types'
import { startAPIServer } from '../src/api'
import { parseChatRequest, type StatelessAgentFactory } from '../src/openai-compat'
import { applyStop, parseRequestParams } from '../src/openai-params'
import type { ChatMessage } from '../src/providers/types'

describe('parseChatRequest', () => {
  test('splits history, new message and system prompt note', () => {
    const parsed = parseChatRequest({
      messages: [
        { role: 'system', content: 'You are a helpful pirate.' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ahoy' },
        { role: 'user', content: [{ type: 'text', text: 'how are you?' }] },
      ],
    })
    if (typeof parsed === 'string') throw new Error(parsed)
    expect(parsed.message).toBe('how are you?')
    expect(parsed.history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ahoy' },
    ])
    expect(parsed.note).toContain('You are a helpful pirate.')
    expect(parsed.note).toContain('does not replace who you are')
  })

  test('drops tool messages and keeps only data: images from the last user turn', () => {
    const parsed = parseChatRequest({
      messages: [
        { role: 'tool', content: 'result', tool_call_id: 'x' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    })
    if (typeof parsed === 'string') throw new Error(parsed)
    expect(parsed.history).toEqual([])
    expect(parsed.images).toEqual(['data:image/png;base64,AAAA'])
    expect(parsed.note).toBeUndefined()
  })

  test('rejects client tools, empty messages and a trailing assistant turn', () => {
    expect(parseChatRequest({ messages: [{ role: 'user', content: 'x' }], tools: [{}] })).toContain(
      'tools',
    )
    expect(parseChatRequest({ messages: [] })).toBe('messages required')
    expect(
      parseChatRequest({
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: 'y' },
        ],
      }),
    ).toBe('the last message must be from the user')
  })
})

describe('parseRequestParams', () => {
  test('maps sampling fields and treats null as unset', () => {
    const p = parseRequestParams({
      temperature: 0.5,
      top_p: 1,
      max_completion_tokens: 200,
      max_tokens: 50,
      seed: 3,
      presence_penalty: null,
      stop: '###',
    })
    if (typeof p === 'string') throw new Error(p)
    // max_completion_tokens is the current name and wins over the alias.
    expect(p.sampling).toEqual({ temperature: 0.5, top_p: 1, max_tokens: 200, seed: 3 })
    expect(p.stop).toEqual(['###'])
  })

  test('a request without sampling fields maps to nothing', () => {
    expect(parseRequestParams({ messages: [] })).toEqual({})
  })

  test('rejects values out of range or of the wrong type', () => {
    expect(parseRequestParams({ temperature: 3 })).toContain('temperature')
    expect(parseRequestParams({ top_p: '0.5' })).toContain('top_p')
    expect(parseRequestParams({ max_tokens: 0 })).toContain('max_tokens')
    expect(parseRequestParams({ max_completion_tokens: 1.5 })).toContain('max_completion_tokens')
    expect(parseRequestParams({ seed: 1.5 })).toContain('seed')
    expect(parseRequestParams({ frequency_penalty: -3 })).toContain('frequency_penalty')
    expect(parseRequestParams({ stop: ['a', 'b', 'c', 'd', 'e'] })).toContain('stop')
    expect(parseRequestParams({ stop: [''] })).toContain('stop')
  })
})

describe('applyStop', () => {
  test('cuts at the earliest stop sequence and drops it', () => {
    expect(applyStop('one\ntwo###three', ['###', '\n'])).toBe('one')
    expect(applyStop('no stops here', ['###'])).toBe('no stops here')
    expect(applyStop('kept', undefined)).toBe('kept')
  })
})

describe('OpenAI-compatible routes', () => {
  let server: ReturnType<typeof startAPIServer>
  let base: string
  let lastSeed: { history: ChatMessage[]; note?: string } | undefined
  let lastRunOpts: AgentLoopOptions | undefined

  // Narrates a run on the bus the way AgentLoop does: a preamble and a tool call, then the
  // answer. The run's content (like AgentLoop's) is the answer turn alone.
  const factory: StatelessAgentFactory = (opts) => {
    lastSeed = opts
    const sessionId = `openai:${crypto.randomUUID()}`
    return {
      getContext: () => ({ sessionId }),
      async run(message: string, runOpts: AgentLoopOptions = {}) {
        lastRunOpts = runOpts
        startRun(sessionId, this as unknown as AgentLoop, message)
        publish(sessionId, { t: 'reasoning', v: 'hmm' })
        publish(sessionId, { t: 'token', v: 'Let me check.' })
        publish(sessionId, { t: 'tool', v: [{ name: 'memory_search', args: '{}' }] })
        publish(sessionId, { t: 'token', v: 'echo: ' })
        publish(sessionId, { t: 'token', v: message })
        const v = {
          content: `echo: ${message}`,
          input_tokens: 3,
          output_tokens: 4,
          turns: 2,
          duration_ms: 0,
          aborted: false,
          awaiting: false,
        }
        endRun(sessionId, { t: 'run_end', v })
        return {
          content: v.content,
          provider: 'test',
          usage: { input_tokens: 3, output_tokens: 4 },
          turns: 2,
          ...(runOpts.sampling?.max_tokens !== undefined && { truncated: true }),
        }
      },
    } as unknown as AgentLoop
  }

  const start = (exposeProgress?: boolean) => {
    server?.stop(true)
    server = startAPIServer(
      { host: '127.0.0.1', port: 0, exposeProgress },
      {
        agentFactory: () => ({}) as AgentLoop,
        agents: new Map(),
        statelessAgentFactory: factory,
        selfName: 'nyx',
      },
    )
    base = `http://127.0.0.1:${server.port}`
  }

  beforeEach(() => {
    resetSessionEvents()
    lastSeed = undefined
    lastRunOpts = undefined
    start()
  })

  afterEach(() => {
    server.stop(true)
  })

  const post = (body: unknown) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  test('GET /v1/models lists the instance as the one model', async () => {
    const body = (await (await fetch(`${base}/v1/models`)).json()) as { data: { id: string }[] }
    expect(body.data.map((m) => m.id)).toEqual(['nyx'])
  })

  test('non-streaming returns a chat.completion and seeds the client history', async () => {
    const res = await post({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      model: string
      choices: { message: { content: string }; finish_reason: string }[]
      usage: { total_tokens: number }
    }
    expect(body.object).toBe('chat.completion')
    // The requested model is ignored: there is one operator.
    expect(body.model).toBe('nyx')
    expect(body.choices[0]?.message.content).toBe('echo: c')
    expect(body.choices[0]?.finish_reason).toBe('stop')
    expect(body.usage.total_tokens).toBe(7)
    expect(lastSeed?.history).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ])
    expect(lastSeed?.note).toContain('be brief')
  })

  test('bad requests get an OpenAI-shaped 400', async () => {
    const res = await post({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function' }],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('tools')
  })

  const streamed = async (body: Record<string, unknown>) => {
    const res = await post({ stream: true, messages: [{ role: 'user', content: 'hi' }], ...body })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const frames = (await res.text())
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => f.slice(6))
    expect(frames[frames.length - 1]).toBe('[DONE]')
    const chunks = frames.slice(0, -1).map(
      (f) =>
        JSON.parse(f) as {
          choices: { delta: Record<string, string>; finish_reason: string | null }[]
          usage?: { total_tokens: number }
        },
    )
    const deltas = chunks.flatMap((c) => c.choices.map((ch) => ch.delta))
    return {
      chunks,
      content: deltas.map((d) => d.content ?? '').join(''),
      reasoning: deltas.map((d) => d.reasoning_content ?? '').join(''),
      finish: chunks.map((c) => c.choices[0]?.finish_reason).find((f) => f),
    }
  }

  test('streaming sends only the answer as content, then usage and [DONE]', async () => {
    const out = await streamed({ stream_options: { include_usage: true } })
    // The preamble before the tool call is not part of the answer.
    expect(out.content).toBe('echo: hi')
    // Progress is hidden by default: a client sees a model, not the run.
    expect(out.reasoning).toBe('')
    expect(out.finish).toBe('stop')
    expect(out.chunks[out.chunks.length - 1]?.usage?.total_tokens).toBe(7)
  })

  test('expose_progress streams thinking, pre-tool text and tool calls as reasoning', async () => {
    start(true)
    const out = await streamed({})
    expect(out.content).toBe('echo: hi')
    expect(out.reasoning).toContain('hmm')
    expect(out.reasoning).toContain('Let me check.')
    expect(out.reasoning).toContain('memory_search')
    // The answer turn's tokens are content, never reasoning.
    expect(out.reasoning).not.toContain('echo')
  })

  test('sampling reaches the run; stop and max_tokens shape the answer', async () => {
    const out = await streamed({ temperature: 0.1, stop: [':'] })
    expect(lastRunOpts?.sampling).toEqual({ temperature: 0.1 })
    expect(out.content).toBe('echo')
    expect(out.finish).toBe('stop')

    const res = await post({ max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })
    const body = (await res.json()) as {
      choices: { message: { content: string }; finish_reason: string }[]
    }
    expect(lastRunOpts?.sampling).toEqual({ max_tokens: 5 })
    expect(body.choices[0]?.message.content).toBe('echo: hi')
    expect(body.choices[0]?.finish_reason).toBe('length')
  })

  test('bad sampling values get an OpenAI-shaped 400 and never start a run', async () => {
    const res = await post({ temperature: 9, messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string; type: string } }
    expect(body.error.message).toContain('temperature')
    expect(body.error.type).toBe('invalid_request_error')
    expect(lastSeed).toBeUndefined()
  })
})
