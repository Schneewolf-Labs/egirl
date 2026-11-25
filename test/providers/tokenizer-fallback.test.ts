/**
 * A tokenizer whose server has no /tokenize stops asking.
 *
 * A hosted OpenAI-compatible API (no /tokenize) was asked for every count and failed every
 * time: one round trip per message, in sequence. The context readout after each turn, /status,
 * and the fit before every request all paid it, as long as the conversation was long.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { computeContextStatus } from '../../src/agent/status'
import { LlamaCppTokenizer } from '../../src/providers/llamacpp-tokenizer'

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => {
  server?.stop(true)
  server = undefined
})

/** A server whose /tokenize answers `status` (200 returns one token per character). */
function fakeServer(status: () => number): { url: string; hits: () => number } {
  let hits = 0
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      hits++
      const s = status()
      if (s !== 200) return new Response('nope', { status: s })
      const { content } = (await req.json()) as { content: string }
      return Response.json({ tokens: [...content].map(() => 1) })
    },
  })
  return { url: `http://localhost:${server.port}`, hits: () => hits }
}

describe('LlamaCppTokenizer fallback', () => {
  test('a 404 means no /tokenize: later counts estimate without asking', async () => {
    const s = fakeServer(() => 404)
    const t = new LlamaCppTokenizer(s.url)
    for (let i = 0; i < 20; i++) expect(await t.countTokens(`message ${i}`)).toBeGreaterThan(0)
    expect(s.hits()).toBe(1)
  })

  test('a transient failure backs off for a minute, then asks again', async () => {
    let status = 500
    let now = 0
    const s = fakeServer(() => status)
    const t = new LlamaCppTokenizer(s.url, undefined, { now: () => now })
    await t.countTokens('a')
    await t.countTokens('b')
    expect(s.hits()).toBe(1)
    status = 200
    now = 61_000
    expect(await t.countTokens('abcd')).toBe(4)
    expect(s.hits()).toBe(2)
  })

  test('estimateOnly (a hosted operator) never asks', async () => {
    const s = fakeServer(() => 200)
    const t = new LlamaCppTokenizer(s.url, undefined, { estimateOnly: true })
    expect(await t.countTokens('x'.repeat(35))).toBe(10)
    expect(s.hits()).toBe(0)
  })

  test('a working server is still asked, and each text once', async () => {
    const s = fakeServer(() => 200)
    const t = new LlamaCppTokenizer(s.url)
    expect(await t.countTokens('hello')).toBe(5)
    expect(await t.countTokens('hello')).toBe(5)
    expect(s.hits()).toBe(1)
  })

  test('a long conversation against a server without /tokenize is counted with one request', async () => {
    const s = fakeServer(() => 404)
    const t = new LlamaCppTokenizer(s.url)
    const context = {
      systemPrompt: 'You are Jaeger.',
      sessionId: 'cli:default',
      messages: Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `turn ${i}` })),
    } as unknown as Parameters<typeof computeContextStatus>[2]
    const config = { local: { contextLength: 131072 } } as Parameters<
      typeof computeContextStatus
    >[0]
    const status = await computeContextStatus(config, t, context)
    expect(status.messageCount).toBe(200)
    expect(s.hits()).toBe(1)
  })
})
