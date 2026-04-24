import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentLoop } from '../src/agent'
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
