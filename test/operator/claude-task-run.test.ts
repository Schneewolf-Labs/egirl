import { describe, expect, test } from 'bun:test'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SessionMutex } from '../../src/agent/session-mutex'
import { ClaudeOperator, type QueryFn } from '../../src/operator/claude'
import type { SessionMap } from '../../src/operator/session-map'
import type { LLMProvider } from '../../src/providers/types'
import type { Tool } from '../../src/tools/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace } from '../agent/helpers'

/**
 * A background task run on the Claude operator. The fake SDK below plays Claude: it connects to
 * the MCP server the operator hands it and calls tools on it, so end_task, a timed-out report
 * ask and the deadline warning go through the same path a live run's tool calls do.
 */

interface Call {
  prompt: string | AsyncIterable<SDKUserMessage>
  options: Options
}

type CallTool = (name: string, args?: Record<string, unknown>) => Promise<unknown>

function msg(m: Record<string, unknown>): SDKMessage {
  return m as unknown as SDKMessage
}

const done = (text: string): SDKMessage =>
  msg({
    type: 'result',
    subtype: 'success',
    result: text,
    num_turns: 3,
    usage: { input_tokens: 10, output_tokens: 5 },
  })

/** A fake Claude that drives the operator's MCP server through `play` before it finishes. */
function scriptedClaude(play: (callTool: CallTool, signal: AbortSignal) => Promise<SDKMessage[]>): {
  query: QueryFn
  calls: Call[]
  listed: string[][]
} {
  const calls: Call[] = []
  const listed: string[][] = []
  const query = ((params: Call) => {
    calls.push(params)
    const servers = params.options.mcpServers as Record<string, { instance: McpServer }>
    const server = servers.egirl?.instance
    const signal = params.options.abortController?.signal as AbortSignal
    return (async function* () {
      yield msg({ type: 'system', subtype: 'init', session_id: `sdk-${calls.length}` })
      if (!server) throw new Error('no egirl MCP server')
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await server.connect(serverSide)
      const client = new Client({ name: 'fake-claude', version: '1' })
      await client.connect(clientSide)
      listed.push((await client.listTools()).tools.map((t) => t.name))
      const callTool: CallTool = (name, args = {}) => client.callTool({ name, arguments: args })
      const tail = await play(callTool, signal)
      // Claude would keep going here; the operator must have stopped it if a tool ended the run.
      await new Promise((r) => setTimeout(r, 5))
      if (signal.aborted) throw new Error('Claude Code process aborted by user')
      for (const m of tail) yield m
    })()
  }) as unknown as QueryFn
  return { query, calls, listed }
}

function memorySessions(): SessionMap & { entries: Map<string, string> } {
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

function tool(name: string, run: () => Promise<Awaited<ReturnType<Tool['execute']>>>): Tool {
  return {
    definition: { name, description: name, parameters: { type: 'object', properties: {} } },
    execute: run,
  }
}

function taskOperator(
  query: QueryFn,
  overrides: Partial<ConstructorParameters<typeof ClaudeOperator>[0]> = {},
): { op: ClaudeOperator; sessions: ReturnType<typeof memorySessions> } {
  const workspace = makeWorkspace()
  const sessions = memorySessions()
  const executor = makeExecutorWithNoop()
  executor.register(
    tool('report', async () => ({ success: false, output: 'no answer', awaitingInput: true })),
  )
  const op = new ClaudeOperator({
    config: makeConfig(workspace),
    toolExecutor: executor,
    sessionId: 'task:abc',
    localProvider: silentProvider,
    sessions,
    queryFn: query,
    ...overrides,
  })
  return { op, sessions }
}

describe('ClaudeOperator on a task run', () => {
  test("the run's own tools are served beside the registry, and end_task ends the run", async () => {
    let extended = 0
    const extraTools = new Map<string, Tool>([
      [
        'request_extension',
        tool('request_extension', async () => {
          extended++
          return { success: true, output: 'granted' }
        }),
      ],
      [
        'end_task',
        tool('end_task', async () => ({
          success: true,
          output: 'ending',
          endRun: { content: 'Finished: notes written.' },
        })),
      ],
    ])
    const { query, listed } = scriptedClaude(async (callTool) => {
      await callTool('noop')
      await callTool('request_extension')
      await callTool('end_task')
      return [done('this should never be the reply')]
    })
    const { op } = taskOperator(query)

    const res = await op.run('do the task', { unbounded: true, extraTools })

    expect(listed[0]).toEqual(
      expect.arrayContaining(['noop', 'report', 'request_extension', 'end_task']),
    )
    expect(extended).toBe(1)
    expect(res.content).toBe('Finished: notes written.')
    expect(res.aborted).toBeUndefined()
    expect(op.isRunning()).toBe(false)
  })

  test("registry tools run under the shared-state lock; the run's own tools do not", async () => {
    const locked: string[] = []
    const sessionMutex = {
      async run<T>(fn: () => Promise<T>): Promise<T> {
        locked.push('lock')
        return fn()
      },
    } as unknown as SessionMutex
    const extraTools = new Map([
      [
        'request_extension',
        tool('request_extension', async () => ({ success: true, output: 'ok' })),
      ],
    ])
    const { query } = scriptedClaude(async (callTool) => {
      await callTool('noop')
      await callTool('request_extension')
      return [done('ok')]
    })
    const { op } = taskOperator(query, { sessionMutex })
    await op.run('go', { extraTools })
    expect(locked).toEqual(['lock'])
  })

  test('a report ask that got no answer parks the run as awaiting input', async () => {
    const { query } = scriptedClaude(async (callTool) => {
      await callTool('report')
      return [done('Waiting on Nina.')]
    })
    const { op } = taskOperator(query)
    const res = await op.run('do the task', { maxTurns: 10 })
    expect(res.awaitingInput).toBe(true)
    expect(res.content).toBe('Waiting on Nina.')
  })

  test('inside the wrap-up margin, the next tool result carries the deadline warning once', async () => {
    const seen: string[][] = []
    const { query } = scriptedClaude(async (callTool) => {
      for (let i = 0; i < 2; i++) {
        const r = (await callTool('noop')) as { content: Array<{ type: string; text?: string }> }
        seen.push(r.content.map((c) => c.text ?? ''))
      }
      return [done('wrapped up')]
    })
    const { op } = taskOperator(query)
    const extraTools = new Map([
      ['end_task', tool('end_task', async () => ({ success: true, output: '' }))],
    ])
    await op.run('do the task', {
      deadline: Date.now() + 2 * 60_000,
      wrapupMarginMs: 5 * 60_000,
      extraTools,
    })
    expect(seen[0]?.[0]).toBe('ok')
    expect(seen[0]?.[1]).toContain('end_task')
    expect(seen[1]).toEqual(['ok'])
  })

  test('a fresh run drops the stored Claude session; a continuing one resumes it', async () => {
    const { query, calls } = scriptedClaude(async () => [done('ok')])
    const sessions = memorySessions()
    sessions.set('task:abc', 'previous-run')

    const continuing = taskOperator(query, { sessions })
    await continuing.op.run('resume')
    expect(calls[0]?.options.resume).toBe('previous-run')

    sessions.set('task:abc', 'previous-run')
    const fresh = taskOperator(query, { sessions, isFresh: true })
    await fresh.op.run('start')
    expect(calls[1]?.options.resume).toBeUndefined()
  })
})
