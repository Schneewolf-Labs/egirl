import { describe, expect, test } from 'bun:test'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { AgentEventHandler } from '../../src/agent/events'
import { resetSessionEvents, subscribe } from '../../src/agent/session-events'
import { ClaudeOperator, type QueryFn } from '../../src/operator/claude'
import type { ClaudeSessionMap } from '../../src/operator/claude-sessions'
import type { LLMProvider, ToolCall } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace } from '../agent/helpers'

/**
 * Claude as the operator: the SDK session is driven with egirl's prompt and tools, resumes the
 * same conversation turn after turn, and reports back in the shape every surface already reads.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUg=='

interface Call {
  prompt: string | AsyncIterable<SDKUserMessage>
  options: Options
}

function memorySessions(): ClaudeSessionMap & { entries: Map<string, string> } {
  const entries = new Map<string, string>()
  return {
    entries,
    get: (k) => entries.get(k),
    set: (k, v) => void entries.set(k, v),
    delete: (k) => void entries.delete(k),
  }
}

const silentProvider: LLMProvider = {
  name: 'stub',
  chat: async () => ({ content: '', usage: { input_tokens: 0, output_tokens: 0 }, model: 'stub' }),
}

function msg(m: Record<string, unknown>): SDKMessage {
  return m as unknown as SDKMessage
}

function result(text: string, extra: Record<string, unknown> = {}): SDKMessage {
  return msg({
    type: 'result',
    subtype: 'success',
    result: text,
    num_turns: 2,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    },
    ...extra,
  })
}

/** A fake SDK: records each query, plays the given script, and ends. */
function fakeQuery(script: (call: Call, index: number) => SDKMessage[]): {
  query: QueryFn
  calls: Call[]
} {
  const calls: Call[] = []
  const query = ((params: Call) => {
    calls.push(params)
    const messages = script(params, calls.length - 1)
    return (async function* () {
      for (const m of messages) yield m
    })()
  }) as unknown as QueryFn
  return { query, calls }
}

function operator(
  query: QueryFn,
  overrides: Partial<ConstructorParameters<typeof ClaudeOperator>[0]> = {},
): { op: ClaudeOperator; sessions: ReturnType<typeof memorySessions>; workspace: string } {
  const workspace = makeWorkspace()
  writeFileSync(join(workspace, 'SOUL.md'), 'You are Claude, and Nina is your principal.')
  const sessions = memorySessions()
  const op = new ClaudeOperator({
    config: makeConfig(workspace),
    toolExecutor: makeExecutorWithNoop(),
    sessionId: 'discord:channel:1',
    localProvider: silentProvider,
    sessions,
    queryFn: query,
    ...overrides,
  })
  return { op, sessions, workspace }
}

describe('ClaudeOperator', () => {
  test('drives the SDK with the workspace prompt and only egirl tools, and mirrors the turn', async () => {
    const { query, calls } = fakeQuery(() => [
      msg({ type: 'system', subtype: 'init', session_id: 'sdk-1' }),
      msg({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } },
      }),
      msg({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      }),
      msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu1', name: 'mcp__egirl__noop', input: { a: 1 } },
            { type: 'text', text: 'hello' },
          ],
        },
      }),
      result('hello from claude'),
    ])
    const { op, sessions, workspace } = operator(query)
    const tokens: string[] = []
    const toolCalls: ToolCall[] = []
    const events: AgentEventHandler = {
      onToken: (t) => void tokens.push(t),
      onToolCallStart: (c) => void toolCalls.push(...c),
    }

    const res = await op.run('hey', { events })

    expect(res.content).toBe('hello from claude')
    expect(res.provider).toBe('claude')
    expect(res.turns).toBe(2)
    expect(res.usage).toEqual({ input_tokens: 1000, output_tokens: 20 })
    expect(tokens.join('')).toBe('hello')
    expect(toolCalls).toEqual([{ id: 'tu1', name: 'noop', arguments: { a: 1 } }])

    expect(calls).toHaveLength(1)
    const opts = calls[0]?.options as Options
    expect(calls[0]?.prompt).toBe('hey')
    expect(opts.systemPrompt).toContain('Nina is your principal')
    expect(opts.tools).toEqual([])
    expect(opts.permissionMode).toBe('bypassPermissions')
    expect(opts.cwd).toBe(workspace)
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(['egirl'])
    expect(opts.resume).toBeUndefined()
    expect(opts.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(opts.thinking).toEqual({ type: 'disabled' })

    expect(sessions.entries.get('discord:channel:1')).toBe('sdk-1')
    expect(op.getContext().messages).toEqual([
      { role: 'user', content: 'hey' },
      { role: 'assistant', content: 'hello from claude' },
    ])
    const status = await op.contextStatus()
    expect(status.contextLength).toBe(200_000)
    expect(status.totalUsed).toBe(1000)
  })

  test('the next turn resumes the session the first one started', async () => {
    const { query, calls } = fakeQuery((_c, i) => [
      msg({ type: 'system', subtype: 'init', session_id: `sdk-${i}` }),
      result(`turn ${i}`),
    ])
    const { op, sessions } = operator(query)
    await op.run('one')
    await op.run('two')
    expect(calls[1]?.options.resume).toBe('sdk-0')
    expect(calls[1]?.options.sessionId).toBeUndefined()
    expect(sessions.entries.get('discord:channel:1')).toBe('sdk-1')
  })

  test('a resume that fails before anything ran starts over once', async () => {
    const { query, calls } = fakeQuery((c) =>
      c.options.resume
        ? [
            msg({
              type: 'result',
              subtype: 'error_during_execution',
              errors: ['No conversation found with session ID: stale'],
              num_turns: 0,
              usage: { input_tokens: 0, output_tokens: 0 },
            }),
          ]
        : [msg({ type: 'system', subtype: 'init', session_id: 'fresh' }), result('ok')],
    )
    const { op, sessions } = operator(query)
    sessions.set('discord:channel:1', 'stale')
    const res = await op.run('hi')
    expect(res.content).toBe('ok')
    expect(calls.map((c) => c.options.resume)).toEqual(['stale', undefined])
    expect(sessions.entries.get('discord:channel:1')).toBe('fresh')
  })

  test('an error result after the session ran is the run failing, and the bus hears it', async () => {
    const { query } = fakeQuery(() => [
      msg({ type: 'system', subtype: 'init', session_id: 'sdk-1' }),
      msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'half' }] },
      }),
      msg({
        type: 'result',
        subtype: 'error_max_turns',
        errors: [],
        num_turns: 10,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ])
    const { op } = operator(query)
    resetSessionEvents()
    const seen: string[] = []
    subscribe('discord:channel:1', (e) => void seen.push(e.t))
    await expect(op.run('go')).rejects.toThrow('error_max_turns')
    expect(seen).toEqual(['run_start', 'error'])
  })

  test('interrupt aborts the SDK run and the reply says so', async () => {
    let signal: AbortSignal | undefined
    const query = ((params: Call) => {
      signal = params.options.abortController?.signal
      return (async function* () {
        yield msg({ type: 'system', subtype: 'init', session_id: 'sdk-1' })
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
        throw new Error('Claude Code process aborted by user')
      })()
    }) as unknown as QueryFn
    const { op } = operator(query)
    const running = op.run('long')
    await new Promise((r) => setTimeout(r, 10))
    expect(op.isRunning()).toBe(true)
    expect(op.interrupt()).toBe(true)
    const res = await running
    expect(res.aborted).toBe(true)
    expect(op.isRunning()).toBe(false)
    expect(op.interrupt()).toBe(false)
  })

  test('the session thinking level becomes the SDK effort', async () => {
    const { query, calls } = fakeQuery(() => [result('ok')])
    const { op } = operator(query)
    op.setThinking('high')
    await op.run('x')
    expect(calls[0]?.options.effort).toBe('high')
    expect(calls[0]?.options.thinking).toBeUndefined()
    expect(op.getThinking()).toEqual({ level: 'high', source: 'session' })
  })

  test('an attached image rides the turn as an image block', async () => {
    const { query, calls } = fakeQuery(() => [result('a cat')])
    const { op } = operator(query)
    await op.run('what is this', { images: [`data:image/png;base64,${PNG}`] })
    const prompt = calls[0]?.prompt
    expect(typeof prompt).not.toBe('string')
    const turns: SDKUserMessage[] = []
    for await (const t of prompt as AsyncIterable<SDKUserMessage>) turns.push(t)
    expect(turns).toHaveLength(1)
    const content = turns[0]?.message.content as Array<Record<string, unknown>>
    expect(content[0]?.type).toBe('text')
    expect(String(content[0]?.text)).toContain('what is this')
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG },
    })
  })

  test('clearContext forgets the Claude session so the next turn starts a new one', async () => {
    const { query, calls } = fakeQuery((_c, i) => [
      msg({ type: 'system', subtype: 'init', session_id: `sdk-${i}` }),
      result('ok'),
    ])
    const { op, sessions } = operator(query)
    await op.run('one')
    op.clearContext()
    expect(sessions.entries.has('discord:channel:1')).toBe(false)
    expect(op.getContext().messages).toEqual([])
    await op.run('two')
    expect(calls[1]?.options.resume).toBeUndefined()
  })
})
