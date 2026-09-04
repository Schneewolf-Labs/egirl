/**
 * Session listing, hydration, and the per-session chat queue.
 *
 * The scenario behind all three: a conversation started in the CLI on one machine, picked up
 * from a browser at work. The list must show sessions this server process has never touched,
 * opening one must load its history instead of 404ing, and two sends racing on the same
 * session must run one after the other -- agent.run() itself does not serialize, so without
 * the queue they would interleave into one context.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentLoop } from '../src/agent'
import { endRun, publish, resetSessionEvents, startRun } from '../src/agent/session-events'
import { type APIConfig, type APIDeps, startAPIServer } from '../src/api'

/** Stub agent whose run() resolves when the test says so, to hold a session busy. */
function gatedAgent(sessionId: string, order: string[]): AgentLoop {
  return {
    async run(message: string) {
      order.push(`start:${message}`)
      // Long enough that a concurrent request would overlap if nothing serialized.
      await new Promise((r) => setTimeout(r, 40))
      order.push(`end:${message}`)
      return {
        content: `echo: ${message}`,
        provider: 'test',
        usage: { input_tokens: 1, output_tokens: 1 },
        turns: 1,
      }
    },
    getContext: () => ({
      sessionId,
      systemPrompt: 'test',
      messages: [],
      conversationSummary: undefined,
    }),
    resetSession() {},
  } as unknown as AgentLoop
}

describe('sessions over the API', () => {
  const agents = new Map<string, AgentLoop>()
  const order: string[] = []
  let server: ReturnType<typeof startAPIServer>
  const port = 3898
  const base = `http://127.0.0.1:${port}`

  // A store that already knows a conversation this server never handled -- the CLI session
  // from the train. lastActiveAt newest-first mirrors the real store's ordering.
  const store = {
    listSessions: () => [
      { id: 'cli:default', channel: 'cli', messageCount: 92, createdAt: 1, lastActiveAt: 2 },
    ],
    loadMessages: (id: string) =>
      id === 'cli:default'
        ? [
            { role: 'user' as const, content: 'from the train' },
            { role: 'assistant' as const, content: 'picked it up' },
          ]
        : [],
    loadSummary: () => undefined,
  }

  const deps: APIDeps = {
    agentFactory: (id) => gatedAgent(id, order),
    agents,
    conversationStore: store,
  }

  beforeEach(() => {
    agents.clear()
    order.length = 0
    server = startAPIServer({ host: '127.0.0.1', port } as APIConfig, deps)
  })

  afterEach(() => {
    server.stop(true)
  })

  test('GET /sessions lists persisted sessions this process never touched', async () => {
    const res = await fetch(`${base}/sessions`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessions: Array<{ id: string; message_count: number }> }
    expect(body.sessions.map((s) => s.id)).toContain('cli:default')
    expect(body.sessions.find((s) => s.id === 'cli:default')?.message_count).toBe(92)
  })

  test('GET /sessions includes live agents the store has not persisted', async () => {
    await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', session_id: 'web:fresh' }),
    })
    const body = (await (await fetch(`${base}/sessions`)).json()) as {
      sessions: Array<{ id: string }>
    }
    expect(body.sessions.map((s) => s.id)).toContain('web:fresh')
  })

  test('opening a persisted session reads it from the store, not a cached agent', async () => {
    const res = await fetch(`${base}/sessions/cli:default`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { messages: Array<{ content: string }> }
    expect(body.messages.map((m) => m.content)).toEqual(['from the train', 'picked it up'])
    // Deliberately NOT hydrated into `agents`. A cached agent only advances on runs made
    // through that instance, so a background task writing the same session id through its own
    // agent would leave this copy frozen -- reading a live task as hundreds of messages stale.
    // Going to disk also means a read no longer has to construct an agent at all.
    expect(agents.has('cli:default')).toBe(false)
  })

  test('a stale cached agent does not shadow the stored conversation', async () => {
    // Found in production: a task had run its conversation to ~1000 messages through the task
    // runner's own agent while this server's cached agent still held the 743 it was hydrated
    // with. The console read the cache and reported a live run as hours stale -- and the report
    // inbox, which pulls a parked task's question from this endpoint, would have shown an old
    // question. Whoever else wrote to the session, a read must reflect it.
    const stale = gatedAgent('cli:default', order)
    stale.getContext = () => ({
      sessionId: 'cli:default',
      systemPrompt: 'test',
      messages: [{ role: 'assistant' as const, content: 'STALE' }],
      conversationSummary: undefined,
    })
    agents.set('cli:default', stale)
    try {
      const body = (await (await fetch(`${base}/sessions/cli:default`)).json()) as {
        messages: Array<{ content: string }>
      }
      expect(body.messages.map((m) => m.content)).toEqual(['from the train', 'picked it up'])
    } finally {
      agents.delete('cli:default')
    }
  })

  test('a session nobody has heard of is still a 404', async () => {
    // GETs that conjure sessions out of typos would fill the picker with ghosts.
    const res = await fetch(`${base}/sessions/typo:nope`)
    expect(res.status).toBe(404)
    expect(agents.has('typo:nope')).toBe(false)
  })

  test('two chats on one session run in order, never interleaved', async () => {
    const [a, b] = await Promise.all([
      fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'first', session_id: 's' }),
      }),
      fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'second', session_id: 's' }),
      }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    // The invariant that matters: no turn starts before the previous one ends.
    const starts = order.filter((e) => e.startsWith('start:'))
    for (let i = 0; i < order.length - 1; i++) {
      if (order[i]?.startsWith('start:')) {
        expect(order[i + 1]).toBe(order[i]?.replace('start:', 'end:'))
      }
    }
    expect(starts).toHaveLength(2)
    // One of the two waited its turn and says so.
    const bodies = [
      (await a.json()) as { queued_behind: number },
      (await b.json()) as { queued_behind: number },
    ]
    expect(bodies.map((x) => x.queued_behind).sort()).toEqual([0, 1])
  })

  test('different sessions do not queue behind each other', async () => {
    const t0 = Date.now()
    await Promise.all([
      fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'a', session_id: 'sx' }),
      }),
      fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'b', session_id: 'sy' }),
      }),
    ])
    // Serial would be ~80ms; parallel ~40ms. The margin keeps CI jitter from flaking this.
    expect(Date.now() - t0).toBeLessThan(75)
  })

  test('a failed turn does not poison the turns queued behind it', async () => {
    let first = true
    const deps2: APIDeps = {
      agentFactory: (id) =>
        ({
          async run(message: string) {
            if (first) {
              first = false
              throw new Error('boom')
            }
            return {
              content: `ok: ${message}`,
              provider: 'test',
              usage: { input_tokens: 1, output_tokens: 1 },
              turns: 1,
            }
          },
          getContext: () => ({ sessionId: id, systemPrompt: '', messages: [] }),
          resetSession() {},
        }) as unknown as AgentLoop,
      agents: new Map(),
    }
    const s2 = startAPIServer({ host: '127.0.0.1', port: 3897 } as APIConfig, deps2)
    try {
      const [a, b] = await Promise.all([
        fetch('http://127.0.0.1:3897/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'fails', session_id: 'q' }),
        }),
        fetch('http://127.0.0.1:3897/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'lives', session_id: 'q' }),
        }),
      ])
      const statuses = [a.status, b.status].sort()
      expect(statuses).toEqual([200, 500])
    } finally {
      s2.stop(true)
    }
  })
})

describe('image attachments', () => {
  test('data URLs reach the agent as content parts; remote URLs are dropped', async () => {
    let seen: unknown
    const deps3: APIDeps = {
      agentFactory: (id) =>
        ({
          async run(_msg: string, options?: { images?: string[] }) {
            seen = options?.images
            return {
              content: 'saw it',
              provider: 'test',
              usage: { input_tokens: 1, output_tokens: 1 },
              turns: 1,
            }
          },
          getContext: () => ({ sessionId: id, systemPrompt: '', messages: [] }),
          resetSession() {},
        }) as unknown as AgentLoop,
      agents: new Map(),
    }
    const s3 = startAPIServer({ host: '127.0.0.1', port: 3896 } as APIConfig, deps3)
    try {
      const res = await fetch('http://127.0.0.1:3896/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'what is this?',
          session_id: 'img',
          // One legitimate data URL, one SSRF attempt, one junk entry.
          images: ['data:image/png;base64,iVBORw0KGgo=', 'http://169.254.169.254/latest', 42],
        }),
      })
      expect(res.status).toBe(200)
      expect(seen).toEqual(['data:image/png;base64,iVBORw0KGgo='])
    } finally {
      s3.stop(true)
    }
  })
})

/** Collect the `data:` frames of an SSE body until it closes. */
async function readFrames(res: Response): Promise<Array<{ t: string; v?: unknown }>> {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as { t: string; v?: unknown })
}

describe('live session events', () => {
  const port = 3895
  const base = `http://127.0.0.1:${port}`
  let server: ReturnType<typeof startAPIServer>
  const finished = {
    t: 'run_end' as const,
    v: {
      content: 'all done',
      input_tokens: 3,
      output_tokens: 4,
      turns: 2,
      duration_ms: 9,
      aborted: false,
      awaiting: false,
    },
  }

  beforeEach(() => {
    resetSessionEvents()
    server = startAPIServer({ host: '127.0.0.1', port } as APIConfig, {
      agentFactory: (id) => gatedAgent(id, []),
      agents: new Map(),
    })
  })
  afterEach(() => {
    server.stop(true)
    resetSessionEvents()
  })

  test('GET /sessions/:id/events relays a run started elsewhere and closes with it', async () => {
    // A task run, a peer message, a send from another device: none of them came through this
    // request, and the spectator sees them all the same because the loop narrates on the bus.
    startRun('task:abc', gatedAgent('task:abc', []), 'grind')
    const res = await fetch(`${base}/sessions/task:abc/events`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    // Give the subscription a beat to attach before publishing.
    await new Promise((r) => setTimeout(r, 20))
    publish('task:abc', { t: 'reasoning', v: 'hmm' })
    publish('task:abc', { t: 'tool', v: ['execute_command'] })
    publish('task:abc', { t: 'token', v: 'all ' })
    endRun('task:abc', finished)
    const frames = await readFrames(res)
    expect(frames.map((f) => f.t)).toEqual(['reasoning', 'tool', 'token', 'run_end'])
    expect((frames[3]?.v as { content: string }).content).toBe('all done')
  })

  test('GET /sessions/:id/events says idle at once when nothing is running', async () => {
    const frames = await readFrames(await fetch(`${base}/sessions/web:quiet/events`))
    expect(frames).toEqual([{ t: 'idle', v: null }])
  })

  test("busy in the session list comes from the bus, not from this server's own queue", async () => {
    startRun('task:abc', gatedAgent('task:abc', []), 'grind')
    const list = (await (await fetch(`${base}/sessions`)).json()) as {
      sessions: Array<{ id: string; busy: boolean }>
    }
    expect(list.sessions.find((s) => s.id === 'task:abc')?.busy).toBe(true)
    endRun('task:abc', finished)
    const after = (await (await fetch(`${base}/sessions`)).json()) as {
      sessions: Array<{ id: string; busy: boolean }>
    }
    expect(after.sessions.find((s) => s.id === 'task:abc')?.busy ?? false).toBe(false)
  })

  test('POST /chat stream:true relays the bus and closes with run_end', async () => {
    // The stub agent never publishes; a real loop would. Its return value still closes the
    // stream, so a client always sees the run end whichever agent sits behind the factory.
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', session_id: 'web:s', stream: true }),
    })
    const frames = await readFrames(res)
    expect(frames.map((f) => f.t)).toEqual(['run_end'])
    expect((frames[0]?.v as { content: string }).content).toBe('echo: hi')
  })

  test('GET /sessions/:id reads the running loop, whoever started it', async () => {
    // A task's loop lives outside this server's agents map, and its context is ahead of
    // anything persisted: the turn in flight is only there. The bus hands over the loop.
    const live = {
      getContext: () => ({
        sessionId: 'task:live',
        systemPrompt: 'x',
        messages: [
          { role: 'user', content: 'grind' },
          { role: 'assistant', content: 'on it' },
        ],
        conversationSummary: undefined,
      }),
    } as unknown as AgentLoop
    startRun('task:live', live, 'grind')
    const res = await fetch(`${base}/sessions/${encodeURIComponent('task:live')}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      busy: boolean
      message_count: number
      messages: Array<{ content: string }>
    }
    expect(body.busy).toBe(true)
    expect(body.message_count).toBe(2)
    expect(body.messages[1]?.content).toBe('on it')
    endRun('task:live', finished)
    expect((await fetch(`${base}/sessions/${encodeURIComponent('task:live')}`)).status).toBe(404)
  })
})
