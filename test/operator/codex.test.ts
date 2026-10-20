import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { AgentEventHandler } from '../../src/agent/events'
import { CodexOperator } from '../../src/operator/codex'
import type { ConnectFn } from '../../src/operator/codex-turn'
import type { SessionMap } from '../../src/operator/session-map'
import type { LLMProvider, ToolCall } from '../../src/providers/types'
import type { CodexEvents, RpcObject } from '../../src/tools/builtin/code-agent/codex-rpc'
import type { Tool } from '../../src/tools/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace } from '../agent/helpers'

/**
 * Codex as the operator, against a fake `codex app-server`: it answers the JSON-RPC requests
 * the operator makes and, once a turn starts, plays a script of notifications and tool calls
 * back, as the real server does over stdio.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUg=='
const TURN = 'turn-1'

interface Script {
  /** Stream text, call tools, and so on, for the turn just started. */
  play(srv: FakeTurn): Promise<void>
  /** Make thread/resume fail with this message. */
  resumeError?: string
}

interface FakeTurn {
  threadId: string
  notify(method: string, params: RpcObject): void
  /** Ask egirl to run a tool, as Codex does, and wait for its answer. */
  callTool(tool: string, args?: RpcObject): Promise<RpcObject>
  say(text: string): void
  usage(input: number, output: number): void
  complete(status?: string, error?: string): void
}

function fakeAppServer(script: Script) {
  const sent: Array<{ method: string; params: RpcObject }> = []
  const closed: boolean[] = []
  const connect: ConnectFn = (_cwd: string, events: CodexEvents) => {
    let threadId = ''
    let nextId = 1000
    let done = false
    const pending = new Map<number | string, (value: RpcObject) => void>()
    const turn: FakeTurn = {
      get threadId() {
        return threadId
      },
      notify: (method, params) =>
        events.notification(method, { threadId, turnId: TURN, ...params }),
      async callTool(tool, args = {}) {
        const id = nextId++
        const answer = new Promise<RpcObject>((resolve) => pending.set(id, resolve))
        await events.request(id, 'item/tool/call', {
          threadId,
          turnId: TURN,
          callId: `call-${id}`,
          namespace: null,
          tool,
          arguments: args,
        })
        return answer
      },
      say(text) {
        turn.notify('item/agentMessage/delta', { itemId: 'm', delta: text })
        turn.notify('item/completed', {
          item: { type: 'agentMessage', id: 'm', text, phase: null },
        })
      },
      usage(input, output) {
        turn.notify('thread/tokenUsage/updated', {
          tokenUsage: {
            total: {},
            last: { inputTokens: input, outputTokens: output },
            modelContextWindow: 400_000,
          },
        })
      },
      complete(status = 'completed', error) {
        if (done) return
        done = true
        events.notification('turn/completed', {
          threadId,
          turn: { id: TURN, status, error: error ? { message: error } : null },
        })
      },
    }
    return {
      async request(method, params) {
        sent.push({ method, params })
        if (method === 'thread/start') {
          threadId = 'thread-new'
          return { thread: { id: threadId } }
        }
        if (method === 'thread/resume') {
          if (script.resumeError) throw new Error(JSON.stringify({ message: script.resumeError }))
          threadId = String(params.threadId)
          return { thread: { id: threadId } }
        }
        if (method === 'turn/start') {
          setTimeout(() => {
            void script.play(turn).then(() => turn.complete())
          }, 0)
          return { turn: { id: TURN } }
        }
        if (method === 'turn/interrupt') {
          setTimeout(() => turn.complete('interrupted'), 0)
          return {}
        }
        return {}
      },
      notify: (method, params) => void sent.push({ method, params }),
      respond: (id, result) => pending.get(id)?.(result),
      reject: (id, message) => pending.get(id)?.({ error: message }),
      async close(force) {
        closed.push(force)
      },
    }
  }
  const of = (method: string) => sent.filter((s) => s.method === method).map((s) => s.params)
  return { connect, sent, of, closed }
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

function codexOperator(
  connect: ConnectFn,
  overrides: Partial<ConstructorParameters<typeof CodexOperator>[0]> = {},
) {
  const workspace = makeWorkspace()
  writeFileSync(join(workspace, 'SOUL.md'), 'You are GPT, and Nina is your principal.')
  const sessions = memorySessions()
  const executor = makeExecutorWithNoop()
  executor.register({
    definition: {
      name: 'screenshot',
      description: 'take one',
      parameters: { type: 'object', properties: {} },
    },
    execute: async () => ({ success: true, output: `data:image/png;base64,${PNG}`, isImage: true }),
  })
  const op = new CodexOperator({
    config: makeConfig(workspace),
    toolExecutor: executor,
    sessionId: 'discord:channel:2',
    localProvider: silentProvider,
    sessions,
    connect,
    ...overrides,
  })
  return { op, sessions, workspace }
}

describe('CodexOperator', () => {
  test('starts a thread with the workspace prompt and only egirl tools, and serves a call', async () => {
    let toolAnswer: RpcObject = {}
    const server = fakeAppServer({
      async play(srv) {
        srv.notify('item/started', {
          item: { type: 'dynamicToolCall', id: 'dt1', tool: 'noop', arguments: { a: 1 } },
        })
        toolAnswer = await srv.callTool('noop', { a: 1 })
        srv.usage(900, 40)
        srv.say('hello from codex')
        srv.usage(1200, 20)
      },
    })
    const { op, sessions, workspace } = codexOperator(server.connect)
    const tokens: string[] = []
    const calls: ToolCall[] = []
    const events: AgentEventHandler = {
      onToken: (t) => void tokens.push(t),
      onToolCallStart: (c) => void calls.push(...c),
    }

    const res = await op.run('hey', { events })

    expect(res.content).toBe('hello from codex')
    expect(res.provider).toBe('codex')
    expect(res.usage).toEqual({ input_tokens: 2100, output_tokens: 60 })
    expect(tokens.join('')).toBe('hello from codex')
    expect(calls).toEqual([{ id: 'dt1', name: 'noop', arguments: { a: 1 } }])
    expect(toolAnswer).toEqual({ contentItems: [{ type: 'inputText', text: 'ok' }], success: true })

    expect(server.of('initialize')[0]?.capabilities).toMatchObject({ experimentalApi: true })
    const start = server.of('thread/start')[0] as RpcObject
    expect(start.baseInstructions).toContain('Nina is your principal')
    expect(start.cwd).toBe(workspace)
    expect(start.environments).toEqual([])
    expect(start.sandbox).toBe('read-only')
    expect(start.approvalPolicy).toBe('never')
    expect(start.config).toMatchObject({
      'features.shell_tool': false,
      'features.multi_agent': false,
      web_search: 'disabled',
    })
    const tools = start.dynamicTools as Array<{ name: string; type: string }>
    expect(tools.map((t) => t.name)).toEqual(['noop', 'screenshot'])
    expect(tools[0]?.type).toBe('function')
    const turnStart = server.of('turn/start')[0] as RpcObject
    expect(turnStart.environments).toEqual([])
    expect(turnStart.effort).toBeUndefined()

    expect(sessions.entries.get('discord:channel:2')).toBe('thread-new')
    expect(server.closed).toEqual([false])
    expect(op.getContext().messages).toEqual([
      { role: 'user', content: 'hey' },
      { role: 'assistant', content: 'hello from codex' },
    ])
    const status = await op.contextStatus()
    expect(status.contextLength).toBe(400_000)
    expect(status.totalUsed).toBe(1200)
  })

  test('the next turn resumes the thread, with the prompt resent and the tools left as started', async () => {
    const server = fakeAppServer({ play: async (srv) => srv.say('ok') })
    const { op } = codexOperator(server.connect)
    await op.run('one')
    await op.run('two')
    const resume = server.of('thread/resume')[0] as RpcObject
    expect(resume.threadId).toBe('thread-new')
    expect(resume.baseInstructions).toContain('Nina is your principal')
    expect(resume.dynamicTools).toBeUndefined()
    expect(server.of('thread/start')).toHaveLength(1)
  })

  test('a thread with no rollout behind it is dropped and a new one started', async () => {
    const server = fakeAppServer({
      resumeError: 'no rollout found for thread id gone',
      play: async (srv) => srv.say('fresh start'),
    })
    const { op, sessions } = codexOperator(server.connect)
    sessions.set('discord:channel:2', 'gone')
    const res = await op.run('hi')
    expect(res.content).toBe('fresh start')
    expect(server.of('thread/start')).toHaveLength(1)
    expect(sessions.entries.get('discord:channel:2')).toBe('thread-new')
  })

  test('any other resume failure fails the turn and keeps the thread id', async () => {
    const server = fakeAppServer({ resumeError: 'auth expired', play: async () => {} })
    const { op, sessions } = codexOperator(server.connect)
    sessions.set('discord:channel:2', 'kept')
    await expect(op.run('hi')).rejects.toThrow('auth expired')
    expect(sessions.entries.get('discord:channel:2')).toBe('kept')
  })

  test('a message injected mid-turn is steered into it', async () => {
    let op!: CodexOperator
    const server = fakeAppServer({
      async play(srv) {
        expect(op.inject('also check the tests')).toBe(true)
        srv.say('done')
      },
    })
    op = codexOperator(server.connect).op
    expect(op.inject('nothing running')).toBe(false)
    await op.run('work')
    const steer = server.of('turn/steer')[0] as RpcObject
    expect(steer.expectedTurnId).toBe(TURN)
    expect(steer.input).toEqual([{ type: 'text', text: 'also check the tests', text_elements: [] }])
  })

  test('interrupt stops the turn and the reply says so', async () => {
    let op!: CodexOperator
    const server = fakeAppServer({
      async play() {
        op.interrupt()
        await new Promise((r) => setTimeout(r, 20))
      },
    })
    op = codexOperator(server.connect).op
    const res = await op.run('long')
    expect(res.aborted).toBe(true)
    expect(server.of('turn/interrupt')).toHaveLength(1)
    expect(server.closed).toEqual([false])
  })

  test('end_task ends the run with its summary, not as a cancellation', async () => {
    const extraTools = new Map<string, Tool>([
      [
        'end_task',
        {
          definition: { name: 'end_task', description: 'stop', parameters: { type: 'object' } },
          execute: async () => ({ success: true, output: '', endRun: { content: 'All done.' } }),
        },
      ],
    ])
    const server = fakeAppServer({
      async play(srv) {
        await srv.callTool('end_task')
        await new Promise((r) => setTimeout(r, 20))
      },
    })
    const { op } = codexOperator(server.connect)
    const res = await op.run('task', { unbounded: true, extraTools })
    expect(res.content).toBe('All done.')
    expect(res.aborted).toBeUndefined()
    const tools = (server.of('thread/start')[0] as RpcObject).dynamicTools as Array<{
      name: string
    }>
    expect(tools.map((t) => t.name)).toContain('end_task')
  })

  test('the turn cap stops a turn after that many tool calls; what was said stands', async () => {
    const server = fakeAppServer({
      async play(srv) {
        srv.say('working on it')
        await srv.callTool('noop')
        await srv.callTool('noop')
        await new Promise((r) => setTimeout(r, 20))
      },
    })
    const { op } = codexOperator(server.connect)
    const res = await op.run('loop', { maxTurns: 2 })
    expect(server.of('turn/interrupt')).toHaveLength(1)
    expect(res.turnLimitReached).toBe(true)
    expect(res.content).toBe('working on it')
  })

  test('a failed turn fails the run', async () => {
    const server = fakeAppServer({
      play: async (srv) => srv.complete('failed', 'usage limit reached'),
    })
    const { op } = codexOperator(server.connect)
    await expect(op.run('x')).rejects.toThrow('usage limit reached')
  })

  test('an attached image goes in as a local file; an image tool result comes back inline', async () => {
    let answer: RpcObject = {}
    const server = fakeAppServer({
      async play(srv) {
        answer = await srv.callTool('screenshot')
        srv.say('a cat')
      },
    })
    const { op } = codexOperator(server.connect)
    await op.run('what is this', { images: [`data:image/png;base64,${PNG}`] })
    const input = (server.of('turn/start')[0] as RpcObject).input as RpcObject[]
    expect(input[0]?.type).toBe('text')
    expect(input[1]?.type).toBe('localImage')
    expect(String(input[1]?.path)).toMatch(/\.png$/)
    expect(answer.contentItems).toEqual([
      { type: 'inputImage', imageUrl: `data:image/png;base64,${PNG}` },
    ])
  })

  test('a fresh operator drops the stored thread; clearContext forgets it too', async () => {
    const server = fakeAppServer({ play: async (srv) => srv.say('ok') })
    const sessions = memorySessions()
    sessions.set('discord:channel:2', 'old')
    const { op } = codexOperator(server.connect, { sessions, isFresh: true })
    expect(sessions.entries.has('discord:channel:2')).toBe(false)
    await op.run('one')
    op.clearContext()
    expect(sessions.entries.has('discord:channel:2')).toBe(false)
  })
})
