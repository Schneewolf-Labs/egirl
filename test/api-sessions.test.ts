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

  test('opening a persisted session hydrates instead of 404ing', async () => {
    const res = await fetch(`${base}/sessions/cli:default`)
    expect(res.status).toBe(200)
    // Hydration goes through the factory, which is what loads history in production.
    expect(agents.has('cli:default')).toBe(true)
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
