/**
 * A hosted OpenAI-compatible operator endpoint (`[local] hosted = true`).
 *
 * llama-server serves the one model it loaded and reads its own request extensions; a hosted API
 * (uncensuredai.com, say) 400s a request with no `model` and errors on `chat_template_kwargs`.
 * Hosted mode names the model and sends only standard OpenAI fields; the default keeps the
 * llama.cpp request exactly as it was.
 */

import { describe, expect, test } from 'bun:test'
import { LlamaCppProvider } from '../../src/providers/llamacpp'

async function requestBody(isHosted: boolean): Promise<Record<string, unknown>> {
  const realFetch = globalThis.fetch
  let body: Record<string, unknown> = {}
  // @ts-expect-error test double
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`),
        )
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    const provider = new LlamaCppProvider(
      'http://stub',
      'glm-5.3-abliterated',
      undefined,
      undefined,
      undefined,
      'key',
      undefined,
      undefined,
      isHosted,
    )
    await provider.chat({
      messages: [{ role: 'user', content: 'hey' }],
      thinking: { level: 'off' },
      cacheSlot: 0,
      onToken: () => {},
    })
    return body
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('hosted operator endpoint', () => {
  test('names the model and sends no llama.cpp-only fields', async () => {
    const body = await requestBody(true)
    expect(body.model).toBe('glm-5.3-abliterated')
    expect(body.chat_template_kwargs).toBeUndefined()
    expect(body.id_slot).toBeUndefined()
    expect(body.cache_slot).toBeUndefined()
    expect(body.return_progress).toBeUndefined()
  })

  test('a llama-server endpoint keeps its own fields and omits the model', async () => {
    const body = await requestBody(false)
    expect(body.model).toBeUndefined()
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body.id_slot).toBe(0)
    expect(body.return_progress).toBe(true)
  })
})
