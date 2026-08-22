/**
 * Bearer auth for a keyed llama-server (--api-key).
 *
 * Needed when the operator model is a shared endpoint that also serves someone else behind an
 * API key — e.g. a single box serving both an egirl instance and a friend over a tunnel. Without
 * this, egirl can't talk to its own model. The key rides on every request (chat and the /v1/models
 * capability probe); an unkeyed provider sends no Authorization header at all.
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

async function capture(
  apiKey?: string,
): Promise<{ chatAuth: string | null; probeAuth: string | null }> {
  const realFetch = globalThis.fetch
  let chatAuth: string | null = null
  let probeAuth: string | null = null
  // @ts-expect-error test double
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null
    if (String(url).includes('/v1/models')) {
      probeAuth = auth
      return new Response(JSON.stringify({ data: [{ id: 'test' }] }), { status: 200 })
    }
    chatAuth = auth
    return new Response(sse([{ choices: [{ delta: { content: 'hi' } }] }]), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  try {
    const provider = new LlamaCppProvider(
      'http://stub',
      'test',
      undefined,
      undefined,
      undefined,
      apiKey,
    )
    await provider.getCapabilities()
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], onToken: () => {} })
    return { chatAuth, probeAuth }
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('llama.cpp api key', () => {
  test('sends Bearer auth on chat and the capability probe when a key is set', async () => {
    const { chatAuth, probeAuth } = await capture('secret-key-123')
    expect(chatAuth).toBe('Bearer secret-key-123')
    expect(probeAuth).toBe('Bearer secret-key-123')
  })

  test('sends no Authorization header when no key is set (open local server)', async () => {
    const { chatAuth, probeAuth } = await capture(undefined)
    expect(chatAuth).toBeNull()
    expect(probeAuth).toBeNull()
  })
})
