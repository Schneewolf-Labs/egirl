/**
 * Client sampling on the wire: each field reaches llama.cpp under its OpenAI name, wins over
 * the provider's own defaults, and an unset field is left out so the server's default holds.
 */

import { describe, expect, test } from 'bun:test'
import { LlamaCppProvider } from '../../src/providers/llamacpp'
import type { ChatRequest } from '../../src/providers/types'

function sse(chunks: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`))
      c.enqueue(enc.encode('data: [DONE]\n\n'))
      c.close()
    },
  })
}

async function captureBody(req: Partial<ChatRequest>): Promise<Record<string, unknown>> {
  const realFetch = globalThis.fetch
  let body: Record<string, unknown> = {}
  // @ts-expect-error test double
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(sse([{ choices: [{ delta: { content: 'hi' } }] }]), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  try {
    const provider = new LlamaCppProvider('http://stub', 'test')
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], ...req })
    return body
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('llama.cpp sampling', () => {
  test('sends every client field under its OpenAI name', async () => {
    const body = await captureBody({
      sampling: {
        temperature: 0.3,
        top_p: 0.8,
        max_tokens: 64,
        seed: 42,
        presence_penalty: 0.5,
        frequency_penalty: -0.5,
      },
    })
    expect(body.temperature).toBe(0.3)
    expect(body.top_p).toBe(0.8)
    expect(body.max_tokens).toBe(64)
    expect(body.seed).toBe(42)
    expect(body.presence_penalty).toBe(0.5)
    expect(body.frequency_penalty).toBe(-0.5)
  })

  test('client values win over the request defaults', async () => {
    const body = await captureBody({
      temperature: 0,
      max_tokens: 1000,
      sampling: { temperature: 1.1, max_tokens: 10 },
    })
    expect(body.temperature).toBe(1.1)
    expect(body.max_tokens).toBe(10)
  })

  test('unset fields stay off the wire', async () => {
    const body = await captureBody({ temperature: 0.4, sampling: { seed: 1 } })
    expect(body.temperature).toBe(0.4)
    expect(body.seed).toBe(1)
    for (const k of ['top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty']) {
      expect(k in body).toBe(false)
    }
  })
})
