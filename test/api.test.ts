import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentLoop } from '../src/agent'
import { endRun, startRun } from '../src/agent/session-events'
import { type APIConfig, type APIDeps, startAPIServer } from '../src/api'

function stubAgent(sessionId: string): AgentLoop {
  const messages: Array<{ role: string; content: string }> = []
  return {
    async run(message: string) {
      messages.push({ role: 'user', content: message })
      messages.push({ role: 'assistant', content: `echo: ${message}` })
      return {
        content: `echo: ${message}`,
        provider: 'test',
        usage: { input_tokens: 1, output_tokens: 2 },
        turns: 1,
      }
    },
    getContext: () => ({
      sessionId,
      systemPrompt: 'test',
      messages,
      conversationSummary: undefined,
    }),
    resetSession() {
      messages.length = 0
    },
  } as unknown as AgentLoop
}

describe('API server', () => {
  const agents = new Map<string, AgentLoop>()
  let server: ReturnType<typeof startAPIServer>
  const port = 3999
  const base = `http://127.0.0.1:${port}`

  const config: APIConfig = { host: '127.0.0.1', port }
  const deps: APIDeps = {
    agentFactory: (id) => stubAgent(id),
    agents,
  }

  beforeEach(() => {
    agents.clear()
    server = startAPIServer(config, deps)
  })

  afterEach(() => {
    server.stop(true)
  })

  test('GET / returns service info', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { service: string }
    expect(body.service).toBe('egirl')
  })

  test('POST /chat echoes via stub agent', async () => {
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: string; session_id: string }
    expect(body.content).toBe('echo: hello')
    expect(body.session_id).toBe('api:default')
  })

  test('POST /chat without message returns 400', async () => {
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('POST /chat then GET /sessions returns messages', async () => {
    await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', session_id: 's1' }),
    })
    const res = await fetch(`${base}/sessions/s1`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { message_count: number }
    expect(body.message_count).toBe(2)
  })

  test('DELETE /sessions/:id clears the session', async () => {
    await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', session_id: 's2' }),
    })
    const del = await fetch(`${base}/sessions/s2`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const res = await fetch(`${base}/sessions/s2`)
    expect(res.status).toBe(404)
  })

  test('GET /peer/identity announces the egirl-peer protocol', async () => {
    const res = await fetch(`${base}/peer/identity`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { service: string; protocol: string; name: string }
    expect(body.service).toBe('egirl')
    expect(body.protocol).toBe('egirl-peer/1')
    expect(body.name).toBe('egirl')
  })

  test('POST /peer/message runs the agent under a peer session', async () => {
    const res = await fetch(`${base}/peer/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'egirl-peer/1', from: 'luna', message: 'status?' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: string; session_id: string; from: string }
    expect(body.session_id).toBe('peer:luna')
    expect(body.from).toBe('egirl')
    // The inbound message is wrapped so the agent knows it's talking to another agent
    expect(body.content).toContain('[agent-to-agent]')
    expect(body.content).toContain('status?')
  })

  test('POST /peer/message answers busy immediately when a run is in flight', async () => {
    // A worker deep in a long unbounded run cannot answer a peer message without queuing behind
    // its current turn, which can take minutes -- so the supervisor's timeout fires and it gets
    // nothing. Instead the receiver checks the session bus, which knows every live run in the
    // process (here: a background task), and replies at once without touching the running work.
    startRun('task:grind', stubAgent('task:grind'), 'keep going')
    const busyServer = startAPIServer(
      { host: '127.0.0.1', port: 3924 },
      { ...deps, selfName: 'zero' },
    )
    try {
      const res = await fetch('http://127.0.0.1:3924/peer/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'emma', message: 'status?' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { busy?: boolean; content: string; from: string }
      expect(body.busy).toBe(true)
      expect(body.from).toBe('zero')
      // It did NOT run the agent, so the message was never wrapped or processed.
      expect(body.content).not.toContain('[agent-to-agent]')

      // And once free, the same message runs the agent normally.
      endRun('task:grind', {
        t: 'run_end',
        v: {
          content: '',
          input_tokens: 0,
          output_tokens: 0,
          turns: 1,
          duration_ms: 0,
          aborted: false,
          awaiting: false,
        },
      })
      const res2 = await fetch('http://127.0.0.1:3924/peer/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'emma', message: 'status?' }),
      })
      const body2 = (await res2.json()) as { busy?: boolean; content: string }
      expect(body2.busy).toBeUndefined()
      expect(body2.content).toContain('[agent-to-agent]')
    } finally {
      busyServer.stop(true)
    }
  })

  test('POST /peer/message persists the peer conversation session', async () => {
    await fetch(`${base}/peer/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'luna', message: 'first' }),
    })
    const res = await fetch(`${base}/sessions/peer:luna`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { message_count: number }
    expect(body.message_count).toBe(2)
  })

  test('POST /peer/message without from or message returns 400', async () => {
    const res = await fetch(`${base}/peer/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /peer/message rejects unknown protocols', async () => {
    const res = await fetch(`${base}/peer/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'other-proto/9', from: 'luna', message: 'hi' }),
    })
    expect(res.status).toBe(400)
  })

  test('GET / on unknown path returns 404', async () => {
    const res = await fetch(`${base}/does-not-exist`)
    expect(res.status).toBe(404)
  })

  test('memory endpoints return 503 when memory is not configured', async () => {
    const res = await fetch(`${base}/memory?q=hi`)
    expect(res.status).toBe(503)
  })

  test('tasks endpoints return 503 when tasks are not configured', async () => {
    const res = await fetch(`${base}/tasks`)
    expect(res.status).toBe(503)
  })
})

describe('API session interrupt', () => {
  const agents = new Map<string, AgentLoop>()
  let server: ReturnType<typeof startAPIServer>
  const port = 3996
  const base = `http://127.0.0.1:${port}`

  let interrupted: string[]
  let injected: Array<{ session: string; message: string }>
  let taskAborts: string[]
  let taskInjects: Array<{ id: string; message: string }>

  function interruptibleAgent(sessionId: string): AgentLoop {
    const stub = stubAgent(sessionId)
    return Object.assign(stub, {
      interrupt: () => {
        interrupted.push(sessionId)
        return true
      },
      inject: (message: string) => {
        injected.push({ session: sessionId, message })
        return true
      },
    }) as AgentLoop
  }

  const taskRunner = {
    abortTask: (id: string) => {
      taskAborts.push(id)
      return true
    },
    injectTask: (id: string, message: string) => {
      taskInjects.push({ id, message })
      return true
    },
  }

  beforeEach(() => {
    agents.clear()
    interrupted = []
    injected = []
    taskAborts = []
    taskInjects = []
    server = startAPIServer(
      { host: '127.0.0.1', port },
      {
        agentFactory: (id) => interruptibleAgent(id),
        agents,
        taskRunner: taskRunner as unknown as APIDeps['taskRunner'],
      },
    )
  })

  afterEach(() => {
    server.stop(true)
  })

  async function interrupt(sessionId: string, body: Record<string, unknown>) {
    return fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('abort reaches the session agent', async () => {
    agents.set('s1', interruptibleAgent('s1'))
    const res = await interrupt('s1', { action: 'abort' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivered: boolean }
    expect(body.delivered).toBe(true)
    expect(interrupted).toContain('s1')
  })

  test('inject reaches the session agent with the message', async () => {
    agents.set('s1', interruptibleAgent('s1'))
    const res = await interrupt('s1', { action: 'inject', message: 'stop and report' })
    expect(res.status).toBe(200)
    expect(injected).toEqual([{ session: 's1', message: 'stop and report' }])
  })

  test('task sessions route to the task runner', async () => {
    const abortRes = await interrupt('task:abc123', { action: 'abort' })
    expect(((await abortRes.json()) as { delivered: boolean }).delivered).toBe(true)
    expect(taskAborts).toContain('abc123')

    await interrupt('task:abc123', { action: 'inject', message: 'note this' })
    expect(taskInjects).toEqual([{ id: 'abc123', message: 'note this' }])
  })

  test('unknown session delivers false instead of erroring', async () => {
    const res = await interrupt('ghost', { action: 'abort' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { delivered: boolean }).delivered).toBe(false)
  })

  test('validates action and inject message', async () => {
    expect((await interrupt('s1', { action: 'explode' })).status).toBe(400)
    expect((await interrupt('s1', { action: 'inject' })).status).toBe(400)
  })
})

describe('API task lifecycle', () => {
  const agents = new Map<string, AgentLoop>()
  let server: ReturnType<typeof startAPIServer>
  const port = 3997
  const base = `http://127.0.0.1:${port}`

  // In-memory stand-ins that record what the API asked of them.
  let tasks: Map<string, { id: string; status: string }>
  let updates: Array<{ id: string; changes: Record<string, unknown>; reason?: string }>
  let aborted: string[]
  let activated: string[]

  const taskStore = {
    get: (id: string) => tasks.get(id),
    update: (id: string, changes: Record<string, unknown>, reason?: string) => {
      updates.push({ id, changes, reason })
      const t = tasks.get(id)
      if (t && typeof changes.status === 'string') t.status = changes.status
    },
    delete: (id: string) => tasks.delete(id),
  }
  const taskRunner = {
    abortTask: (id: string) => {
      aborted.push(id)
      return id === 'running1'
    },
    activateTask: (id: string) => {
      activated.push(id)
    },
  }

  beforeEach(() => {
    agents.clear()
    tasks = new Map([
      ['t1', { id: 't1', status: 'active' }],
      ['running1', { id: 'running1', status: 'active' }],
    ])
    updates = []
    aborted = []
    activated = []
    server = startAPIServer(
      { host: '127.0.0.1', port },
      {
        agentFactory: (id) => stubAgent(id),
        agents,
        taskStore: taskStore as unknown as APIDeps['taskStore'],
        taskRunner: taskRunner as unknown as APIDeps['taskRunner'],
      },
    )
  })

  afterEach(() => {
    server.stop(true)
  })

  test('POST /tasks/:id/pause pauses the task', async () => {
    const res = await fetch(`${base}/tasks/t1/pause`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(tasks.get('t1')?.status).toBe('paused')
  })

  test('POST /tasks/:id/resume reactivates and clears failures', async () => {
    tasks.set('t1', { id: 't1', status: 'paused' })
    const res = await fetch(`${base}/tasks/t1/resume`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(tasks.get('t1')?.status).toBe('active')
    expect(updates[0]?.changes.consecutiveFailures).toBe(0)
    expect(activated).toContain('t1')
  })

  test('DELETE /tasks/:id removes the task', async () => {
    const res = await fetch(`${base}/tasks/t1`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { aborted_running: boolean }
    expect(body.aborted_running).toBe(false)
    expect(tasks.has('t1')).toBe(false)
  })

  test('DELETE /tasks/:id aborts a running instance first', async () => {
    const res = await fetch(`${base}/tasks/running1`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { aborted_running: boolean }
    expect(body.aborted_running).toBe(true)
    expect(aborted).toContain('running1')
    expect(tasks.has('running1')).toBe(false)
  })

  test('a chat reply on a parked task session resumes the task', async () => {
    tasks.set('t1', { id: 't1', status: 'awaiting' })
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'use the DX9 build', session_id: 'task:t1' }),
    })
    expect(res.status).toBe(200)
    expect(tasks.get('t1')?.status).toBe('active')
    const resume = updates.find((u) => u.changes.status === 'active')
    expect(resume?.changes.nextRunAt).toBeNumber()
    expect(resume?.reason).toContain('resuming')
  })

  test('a chat on an active task session does not touch the task', async () => {
    await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'just checking in', session_id: 'task:t1' }),
    })
    expect(updates).toHaveLength(0)
  })

  test('lifecycle routes 404 on unknown tasks', async () => {
    for (const [method, url] of [
      ['POST', `${base}/tasks/nope/pause`],
      ['POST', `${base}/tasks/nope/resume`],
      ['DELETE', `${base}/tasks/nope`],
    ] as const) {
      const res = await fetch(url, { method })
      expect(res.status).toBe(404)
    }
  })
})

describe('API bearer auth', () => {
  const agents = new Map<string, AgentLoop>()
  let server: ReturnType<typeof startAPIServer>
  const port = 3998
  const base = `http://127.0.0.1:${port}`

  beforeEach(() => {
    agents.clear()
    server = startAPIServer(
      { host: '127.0.0.1', port, bearerToken: 'secret' },
      { agentFactory: (id) => stubAgent(id), agents },
    )
  })

  afterEach(() => {
    server.stop(true)
  })

  test('rejects request without auth', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(401)
  })

  test('rejects request with wrong token', async () => {
    const res = await fetch(`${base}/`, {
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.status).toBe(401)
  })

  test('accepts request with correct token', async () => {
    const res = await fetch(`${base}/`, {
      headers: { authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
  })
})
