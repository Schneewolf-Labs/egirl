/**
 * Slot pinning has to reach the server under the name it actually reads. sabrewing looks for
 * `cache_slot`; llama.cpp looks for `id_slot` and silently ignored the sabrewing name, so the
 * LRU pool in agent/cache-slots.ts pinned nothing on a multi-slot llama-server.
 */

import { describe, expect, test } from 'bun:test'
import { LlamaCppProvider } from '../../src/providers/llamacpp'

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

async function captureBody(cacheSlot?: number): Promise<Record<string, unknown>> {
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
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], cacheSlot })
    return body
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('cache slot pinning', () => {
  test('sends the slot under both the sabrewing and llama.cpp names', async () => {
    const body = await captureBody(2)
    expect(body.cache_slot).toBe(2)
    expect(body.id_slot).toBe(2)
  })

  test('sends neither when pinning is disabled', async () => {
    const body = await captureBody(undefined)
    expect('cache_slot' in body).toBe(false)
    expect('id_slot' in body).toBe(false)
  })
})
