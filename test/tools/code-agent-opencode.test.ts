import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionSupervisor } from '../../src/permissions/supervisor'
import { runOpencodeCodeAgent } from '../../src/tools/builtin/code-agent/opencode'
import { TIMEOUT_PREFIX } from '../../src/tools/builtin/code-agent/timeout-report'
import type { CodeAgentConfig } from '../../src/tools/builtin/code-agent/types'

/**
 * Unit tests for the opencode code-agent backend
 * (src/tools/builtin/code-agent/opencode.ts).
 *
 * The backend shells out to `opencode serve`; here `child_process.spawn` is
 * mocked and the "server" is a fake HTTP endpoint (Bun.serve on 127.0.0.1)
 * that speaks just enough of opencode's API: POST /session, POST
 * /session/:id/message, POST /session/:id/permissions/:pid, and the GET
 * /event SSE stream. No real opencode binary, no real network.
 */

interface FakeProc extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (signal?: string) => boolean
}

// Mutable per-test state read by the mocked spawn at call time.
const spawned: { args: string[]; proc: FakeProc }[] = []
let announceUrl: string | null = null
let spawnError: Error | null = null

// The real spawn, for commands other than `opencode` (e.g. the git calls the
// timeout report makes). process.getBuiltinModule bypasses the mock below.
const realChildProcess = (
  process as unknown as {
    getBuiltinModule: (id: string) => { spawn: (...args: unknown[]) => unknown }
  }
).getBuiltinModule('node:child_process')

mock.module('child_process', () => ({
  spawn: (cmd: string, args: string[], opts?: unknown) => {
    if (cmd !== 'opencode') return realChildProcess.spawn(cmd, args, opts)
    const proc = new EventEmitter() as FakeProc
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = mock(() => true)
    spawned.push({ args: [cmd, ...args], proc })
    queueMicrotask(() => {
      if (spawnError) proc.emit('error', spawnError)
      else if (announceUrl)
        proc.stdout.emit('data', Buffer.from(`opencode v0.0-test\nlistening on ${announceUrl}\n`))
    })
    return proc
  },
}))

interface RecordedCall {
  method: string
  path: string
  directory: string | null
  body: unknown
}

interface PermissionReply {
  sessionId: string
  permissionId: string
  response: unknown
}

interface FakeOpencode {
  url: string
  calls: RecordedCall[]
  permissionReplies: PermissionReply[]
  /** Resolve the pending prompt request, if the prompt is gated. */
  releasePrompt: () => void
  pushEvent: (event: unknown) => void
  pushRaw: (frame: string) => void
  waitForSse: () => Promise<void>
  close: () => void
}

function startFakeOpencode(behavior: {
  sessionCreateStatus?: number
  promptStatus?: number
  promptBody?: unknown
  hangPrompt?: boolean
  gatePrompt?: boolean
}): FakeOpencode {
  const calls: RecordedCall[] = []
  const permissionReplies: PermissionReply[] = []
  let sse: ReadableStreamDefaultController<string> | null = null
  let sseConnectedResolve: () => void = () => {}
  const sseConnected = new Promise<void>((resolve) => {
    sseConnectedResolve = resolve
  })
  let releasePrompt: () => void = () => {}
  const promptGate = behavior.gatePrompt
    ? new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    : null

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      const path = url.pathname
      if (path === '/event') {
        const stream = new ReadableStream<string>({
          start(controller) {
            sse = controller
            sseConnectedResolve()
          },
        })
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
      }
      let body: unknown = null
      try {
        body = await req.json()
      } catch {
        // no JSON body
      }
      calls.push({ method: req.method, path, directory: url.searchParams.get('directory'), body })
      if (path === '/session' && req.method === 'POST') {
        if (behavior.sessionCreateStatus && behavior.sessionCreateStatus !== 200) {
          return new Response('nope', { status: behavior.sessionCreateStatus })
        }
        return Response.json({ id: 'sess-1' })
      }
      const messageMatch = path.match(/^\/session\/([^/]+)\/message$/)
      if (messageMatch && req.method === 'POST') {
        if (behavior.hangPrompt) return new Promise<Response>(() => {})
        if (promptGate) await promptGate
        if (behavior.promptStatus && behavior.promptStatus !== 200) {
          return new Response('boom', { status: behavior.promptStatus })
        }
        return Response.json(
          behavior.promptBody ?? { info: {}, parts: [{ type: 'text', text: 'All done.' }] },
        )
      }
      const permMatch = path.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/)
      if (permMatch && req.method === 'POST') {
        const reply = body as { response?: unknown }
        permissionReplies.push({
          sessionId: permMatch[1] ?? '',
          permissionId: permMatch[2] ?? '',
          response: reply?.response,
        })
        return Response.json({})
      }
      return new Response('not found', { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    permissionReplies,
    releasePrompt,
    pushEvent: (event: unknown) => {
      sse?.enqueue(`data: ${JSON.stringify(event)}\n\n`)
    },
    pushRaw: (frame: string) => {
      sse?.enqueue(frame)
    },
    waitForSse: () => sseConnected,
    close: () => server.stop(),
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const baseConfig = (dir: string, extra: Partial<CodeAgentConfig> = {}): CodeAgentConfig => ({
  permissionMode: 'bypassPermissions',
  workingDir: dir,
  ...extra,
})

const supervisor = (action: string, reason = 'test reason') =>
  ({
    decide: async () => ({ action, reason }),
  }) as unknown as PermissionSupervisor

function messagePart(part: Record<string, unknown>) {
  return { type: 'message.part.updated', properties: { part } }
}

function permissionEvent(sessionID: string, id = 'perm-1') {
  return {
    type: 'permission.updated',
    properties: {
      id,
      type: 'edit',
      title: 'Edit src/a.ts',
      sessionID,
      metadata: { path: 'src/a.ts' },
    },
  }
}

/** Fresh backend + fake server wiring for one test. */
function setup(behavior: Parameters<typeof startFakeOpencode>[0] = {}): {
  dir: string
  fake: FakeOpencode
} {
  spawned.length = 0
  spawnError = null
  const dir = mkdtempSync(join(tmpdir(), 'egirl-opencode-'))
  const fake = startFakeOpencode(behavior)
  announceUrl = fake.url
  return { dir, fake }
}

describe('opencode backend: happy path', () => {
  test('creates a session, sends the task, and returns the final text', async () => {
    const { dir, fake } = setup()
    const result = await runOpencodeCodeAgent(baseConfig(dir), 'do the thing', dir)
    try {
      expect(result.success).toBe(true)
      expect(result.output).toContain('All done.')
      expect(result.output).toContain('[code_agent: opencode')
      expect(result.output).toContain('session: sess-1')

      expect(spawned[0]?.args).toEqual([
        'opencode',
        'serve',
        '--port',
        '0',
        '--hostname',
        '127.0.0.1',
      ])

      const create = fake.calls.find((c) => c.path === '/session')
      expect(create?.method).toBe('POST')
      expect(create?.directory).toBe(dir)
      expect((create?.body as { title?: string })?.title).toBe('do the thing')

      const prompt = fake.calls.find((c) => c.path === '/session/sess-1/message')
      expect(prompt?.method).toBe('POST')
      expect(prompt?.directory).toBe(dir)
      const parts = (prompt?.body as { parts?: { type: string; text: string }[] })?.parts
      expect(parts).toEqual([{ type: 'text', text: 'do the thing' }])
      expect('model' in ((prompt?.body as Record<string, unknown>) ?? {})).toBe(false)
    } finally {
      fake.close()
    }
  })

  test('passes provider/model through as providerID/modelID', async () => {
    const { dir, fake } = setup()
    try {
      await runOpencodeCodeAgent(baseConfig(dir, { model: 'anthropic/claude-x' }), 't', dir)
      const prompt = fake.calls.find((c) => c.path === '/session/sess-1/message')
      expect((prompt?.body as { model?: unknown })?.model).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-x',
      })
    } finally {
      fake.close()
    }
  })

  test('splits the model on the first slash only', async () => {
    const { dir, fake } = setup()
    try {
      await runOpencodeCodeAgent(baseConfig(dir, { model: 'a/b/c' }), 't', dir)
      const prompt = fake.calls.find((c) => c.path === '/session/sess-1/message')
      expect((prompt?.body as { model?: unknown })?.model).toEqual({
        providerID: 'a',
        modelID: 'b/c',
      })
    } finally {
      fake.close()
    }
  })

  test('joins non-synthetic text parts and drops synthetic ones', async () => {
    const { dir, fake } = setup({
      promptBody: {
        info: {},
        parts: [
          { type: 'text', text: 'First.' },
          { type: 'text', text: 'internal reasoning', synthetic: true },
          { type: 'text', text: 'Second.' },
          { type: 'tool', text: 'not text output' },
          { type: 'text' },
        ],
      },
    })
    try {
      const result = await runOpencodeCodeAgent(baseConfig(dir), 't', dir)
      expect(result.success).toBe(true)
      expect(result.output).toContain('First.\n\nSecond.')
      expect(result.output).not.toContain('internal reasoning')
    } finally {
      fake.close()
    }
  })

  test('appends image paths to the task text', async () => {
    const { dir, fake } = setup()
    try {
      await runOpencodeCodeAgent(baseConfig(dir), 'look at this', dir, ['/tmp/a.png'])
      const prompt = fake.calls.find((c) => c.path === '/session/sess-1/message')
      const parts = (prompt?.body as { parts?: { text: string }[] })?.parts
      expect(parts?.[0]?.text).toContain('look at this')
      expect(parts?.[0]?.text).toContain('- /tmp/a.png')
    } finally {
      fake.close()
    }
  })

  test('kills the server process when done', async () => {
    const { dir, fake } = setup()
    try {
      await runOpencodeCodeAgent(baseConfig(dir), 't', dir)
      expect(spawned).toHaveLength(1)
      expect(spawned[0]?.proc.kill).toHaveBeenCalledWith('SIGTERM')
    } finally {
      fake.close()
    }
  })

  test('resumeSession skips session creation and posts to the given session', async () => {
    const { dir, fake } = setup()
    try {
      const result = await runOpencodeCodeAgent(baseConfig(dir), 'continue', dir, [], {
        resumeSession: 'sess-9',
      })
      expect(result.success).toBe(true)
      expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/session')).toBe(false)
      expect(fake.calls.some((c) => c.path === '/session/sess-9/message')).toBe(true)
      expect(result.output).toContain('session: sess-9')
    } finally {
      fake.close()
    }
  })
})

describe('opencode backend: permissions', () => {
  test('bypassPermissions auto-approves without a supervisor', async () => {
    const { dir, fake } = setup({ gatePrompt: true })
    try {
      const run = runOpencodeCodeAgent(baseConfig(dir), 't', dir)
      await fake.waitForSse()
      fake.pushEvent(permissionEvent('sess-1'))
      await waitFor(() => fake.permissionReplies.length > 0)
      fake.releasePrompt()
      const result = await run
      expect(result.success).toBe(true)
      expect(fake.permissionReplies).toEqual([
        { sessionId: 'sess-1', permissionId: 'perm-1', response: 'once' },
      ])
    } finally {
      fake.close()
    }
  })

  test('a supervisor allow approves once', async () => {
    const { dir, fake } = setup({ gatePrompt: true })
    const seen: unknown[] = []
    const sup = {
      decide: async (req: unknown) => {
        seen.push(req)
        return { action: 'allow', reason: 'fine' }
      },
    } as unknown as PermissionSupervisor
    try {
      const run = runOpencodeCodeAgent(
        baseConfig(dir, { permissionMode: 'default', permissionSupervisor: sup }),
        't',
        dir,
      )
      await fake.waitForSse()
      fake.pushEvent(permissionEvent('sess-1'))
      await waitFor(() => fake.permissionReplies.length > 0)
      fake.releasePrompt()
      const result = await run
      expect(result.success).toBe(true)
      expect(fake.permissionReplies[0]?.response).toBe('once')
      const req = seen[0] as Record<string, unknown>
      expect(req).toMatchObject({ backend: 'opencode', toolName: 'edit' })
      expect(String(req.promptText)).toContain('Edit src/a.ts')
    } finally {
      fake.close()
    }
  })

  test('a supervisor deny rejects', async () => {
    const { dir, fake } = setup({ gatePrompt: true })
    try {
      const run = runOpencodeCodeAgent(
        baseConfig(dir, {
          permissionMode: 'default',
          permissionSupervisor: supervisor('deny', 'nope'),
        }),
        't',
        dir,
      )
      await fake.waitForSse()
      fake.pushEvent(permissionEvent('sess-1'))
      await waitFor(() => fake.permissionReplies.length > 0)
      fake.releasePrompt()
      const result = await run
      expect(result.success).toBe(true)
      expect(fake.permissionReplies[0]?.response).toBe('reject')
    } finally {
      fake.close()
    }
  })

  test('ask_user escalates, rejects the permission, and aborts the run', async () => {
    const { dir, fake } = setup({ hangPrompt: true })
    try {
      const run = runOpencodeCodeAgent(
        baseConfig(dir, {
          permissionMode: 'default',
          permissionSupervisor: supervisor('ask_user', 'need eyes on this'),
        }),
        't',
        dir,
      )
      await fake.waitForSse()
      fake.pushEvent(permissionEvent('sess-1'))
      // The permission reply is fire-and-forget inside the backend: it can still
      // be in flight when the run resolves, so wait for it before asserting and
      // closing the server.
      await waitFor(() => fake.permissionReplies.length > 0)
      const result = await run
      expect(result.success).toBe(false)
      expect(result.output).toContain('Code agent needs user approval before continuing.')
      expect(result.output).toContain('need eyes on this')
      expect(fake.permissionReplies[0]?.response).toBe('reject')
    } finally {
      fake.close()
    }
  })

  test('ignores permission events for other sessions', async () => {
    const { dir, fake } = setup({ gatePrompt: true })
    try {
      const run = runOpencodeCodeAgent(
        baseConfig(dir, {
          permissionMode: 'default',
          permissionSupervisor: supervisor('deny'),
        }),
        't',
        dir,
      )
      await fake.waitForSse()
      fake.pushEvent(permissionEvent('sess-other'))
      fake.releasePrompt()
      const result = await run
      expect(result.success).toBe(true)
      expect(fake.permissionReplies).toHaveLength(0)
    } finally {
      fake.close()
    }
  })

  test('a throwing supervisor does not fail the run', async () => {
    const { dir, fake } = setup({ gatePrompt: true })
    const sup = {
      decide: async () => {
        throw new Error('supervisor exploded')
      },
    } as unknown as PermissionSupervisor
    try {
      const run = runOpencodeCodeAgent(
        baseConfig(dir, { permissionMode: 'default', permissionSupervisor: sup }),
        't',
        dir,
      )
      await fake.waitForSse()
      fake.pushEvent(permissionEvent('sess-1'))
      // Give the fire-and-forget handler a beat, then let the prompt finish.
      await new Promise((resolve) => setTimeout(resolve, 100))
      fake.releasePrompt()
      const result = await run
      expect(result.success).toBe(true)
      expect(fake.permissionReplies).toHaveLength(0)
    } finally {
      fake.close()
    }
  })
})

describe('opencode backend: error paths', () => {
  test('a spawn error surfaces as a code agent error', async () => {
    const { dir, fake } = setup()
    spawnError = new Error('spawn opencode ENOENT')
    try {
      const result = await runOpencodeCodeAgent(baseConfig(dir), 't', dir)
      expect(result.success).toBe(false)
      expect(result.output).toBe('Code agent error: spawn opencode ENOENT')
    } finally {
      fake.close()
    }
  })

  test('a session creation failure surfaces the status', async () => {
    const { dir, fake } = setup({ sessionCreateStatus: 500 })
    try {
      const result = await runOpencodeCodeAgent(baseConfig(dir), 't', dir)
      expect(result.success).toBe(false)
      expect(result.output).toContain('Failed to create opencode session: 500')
    } finally {
      fake.close()
    }
  })

  test('a prompt failure surfaces the status', async () => {
    const { dir, fake } = setup({ promptStatus: 500 })
    try {
      const result = await runOpencodeCodeAgent(baseConfig(dir), 't', dir)
      expect(result.success).toBe(false)
      expect(result.output).toContain('opencode prompt failed: 500')
    } finally {
      fake.close()
    }
  })

  test('a prompt info.error fails the run', async () => {
    const { dir, fake } = setup({
      promptBody: { info: { error: { message: 'model blew up' } }, parts: [] },
    })
    try {
      const result = await runOpencodeCodeAgent(baseConfig(dir), 't', dir)
      expect(result.success).toBe(false)
      expect(result.output).toContain('Code agent error:')
      expect(result.output).toContain('model blew up')
    } finally {
      fake.close()
    }
  })

  test('malformed SSE frames are ignored', async () => {
    const { dir, fake } = setup()
    try {
      const run = runOpencodeCodeAgent(baseConfig(dir), 't', dir)
      await fake.waitForSse()
      fake.pushRaw('data: this is not json\n\n')
      fake.pushRaw('not even a data line\n\n')
      const result = await run
      expect(result.success).toBe(true)
      expect(result.output).toContain('All done.')
    } finally {
      fake.close()
    }
  })
})

describe('opencode backend: timeout', () => {
  test('a hanging prompt yields a timeout report with actions and the last message', async () => {
    const { dir, fake } = setup({ hangPrompt: true })
    try {
      const run = runOpencodeCodeAgent(baseConfig(dir, { timeoutMs: 200 }), 't', dir)
      await fake.waitForSse()
      fake.pushEvent(
        messagePart({
          sessionID: 'sess-1',
          type: 'text',
          text: 'Working on it, almost there.',
        }),
      )
      fake.pushEvent(
        messagePart({
          sessionID: 'sess-1',
          type: 'tool',
          id: 'tool-1',
          tool: 'Bash',
          state: { input: { command: 'ls -la' } },
        }),
      )
      // A duplicate tool id and an event for another session must not pollute the report.
      fake.pushEvent(
        messagePart({
          sessionID: 'sess-1',
          type: 'tool',
          id: 'tool-1',
          tool: 'Bash',
          state: { input: { command: 'ls -la' } },
        }),
      )
      fake.pushEvent(messagePart({ sessionID: 'sess-other', type: 'text', text: 'noise' }))
      const result = await run
      expect(result.success).toBe(false)
      expect(result.output.startsWith(TIMEOUT_PREFIX)).toBe(true)
      expect(result.output).toContain('(opencode, 1 tool calls)')
      expect(result.output).toContain('- Bash')
      expect(result.output).toContain('ls -la')
      expect(result.output).toContain('Last message from the agent:')
      expect(result.output).toContain('Working on it, almost there.')
      expect(result.output).not.toContain('noise')
      expect(result.output).toContain('resume_session="opencode:sess-1"')
    } finally {
      fake.close()
    }
  })
})
