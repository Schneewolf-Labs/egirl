/**
 * The thinking switch on the wire.
 *
 * llama.cpp passes template variables only from `chat_template_kwargs`; a top-level
 * `enable_thinking` is ignored without complaint, and a Qwen3-class template then defaults to
 * thinking ON. That is how `thinking.level = "off"` and `/think off` both left the model
 * reasoning through "hey" for fifteen seconds. Pin the shape, not just the value.
 */

import { describe, expect, test } from 'bun:test'
import { LlamaCppProvider } from '../../src/providers/llamacpp'
import type { ThinkingConfig } from '../../src/providers/types'

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

async function requestBody(thinking?: ThinkingConfig): Promise<Record<string, unknown>> {
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
    await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      thinking,
      onToken: () => {},
    })
    return body
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('llama.cpp thinking switch', () => {
  test('off is sent as a template variable, the only form llama.cpp reads', async () => {
    const body = await requestBody({ level: 'off' })
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body).not.toHaveProperty('enable_thinking')
  })

  test('any other level turns it on the same way', async () => {
    const body = await requestBody({ level: 'medium' })
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  test('with no thinking config the template keeps its own default', async () => {
    const body = await requestBody(undefined)
    expect(body).not.toHaveProperty('chat_template_kwargs')
  })
})
