import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentLoop } from '../src/agent'
import { endRun, publish, resetSessionEvents, startRun } from '../src/agent/session-events'
import { startAPIServer } from '../src/api'
import { parseChatRequest, type StatelessAgentFactory, streamTail } from '../src/openai-compat'
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

describe('streamTail', () => {
  test('sends only what the stream has not already carried', () => {
    expect(streamTail('hello world', 'hello', true)).toBe(' world')
    expect(streamTail('hello', 'hello', true)).toBe('')
    expect(streamTail('answer', '', false)).toBe('answer')
    // The last turn produced no tokens after a tool call: separate it from the preamble.
    expect(streamTail('answer', '', true)).toBe('\n\nanswer')
    expect(streamTail('', 'x', true)).toBe('')
  })
})

describe('OpenAI-compatible routes', () => {
  let server: ReturnType<typeof startAPIServer>
  let base: string
  let lastSeed: { history: ChatMessage[]; note?: string } | undefined

  // Narrates a run on the bus the way AgentLoop does: a tool call, then the answer.
  const factory: StatelessAgentFactory = (opts) => {
    lastSeed = opts
    const sessionId = `openai:${crypto.randomUUID()}`
    return {
      getContext: () => ({ sessionId }),
      async run(message: string) {
        startRun(sessionId, this as unknown as AgentLoop, message)
        publish(sessionId, { t: 'reasoning', v: 'hmm' })
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
        }
      },
    } as unknown as AgentLoop
  }

  beforeEach(() => {
    resetSessionEvents()
    lastSeed = undefined
    server = startAPIServer(
      { host: '127.0.0.1', port: 0 },
      {
        agentFactory: () => ({}) as AgentLoop,
        agents: new Map(),
        statelessAgentFactory: factory,
        selfName: 'nyx',
      },
    )
    base = `http://127.0.0.1:${server.port}`
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

  test('streaming sends reasoning, tool activity and content chunks, then [DONE]', async () => {
    const res = await post({
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const text = await res.text()
    const frames = text
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
    const content = deltas.map((d) => d.content ?? '').join('')
    const reasoning = deltas.map((d) => d.reasoning_content ?? '').join('')
    expect(content).toBe('echo: hi')
    expect(reasoning).toContain('hmm')
    expect(reasoning).toContain('memory_search')
    expect(chunks.some((c) => c.choices[0]?.finish_reason === 'stop')).toBe(true)
    expect(chunks[chunks.length - 1]?.usage?.total_tokens).toBe(7)
  })
})
