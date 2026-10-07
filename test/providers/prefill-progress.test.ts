import { afterEach, describe, expect, test } from 'bun:test'
import { LlamaCppProvider } from '../../src/providers/llamacpp'

/**
 * A slow cold prefill streams nothing but llama.cpp's prompt_progress chunks (requested with
 * return_progress). Those must keep the stale-stream timer alive; silence must still trip it.
 */

const enc = new TextEncoder()
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`)

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => {
  server?.stop(true)
  server = undefined
})

/** Fake llama-server: `gaps` ms pauses, each followed by a progress chunk (or nothing), then an answer. */
function fakeServer(gaps: number[], sendProgress: boolean, seen: Record<string, unknown>[]) {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push((await req.json()) as Record<string, unknown>)
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            // llama-server opens the stream at once; the silence is inside it.
            controller.enqueue(sse({ choices: [{ delta: { role: 'assistant' } }] }))
            let processed = 0
            for (const gap of gaps) {
              await Bun.sleep(gap)
              processed += 100
              if (sendProgress) {
                controller.enqueue(
                  sse({
                    choices: [],
                    prompt_progress: { total: 1000, cache: 0, processed, time_ms: processed },
                  }),
                )
              }
            }
            controller.enqueue(sse({ choices: [{ delta: { content: 'answer' } }] }))
            controller.enqueue(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
            controller.enqueue(enc.encode('data: [DONE]\n\n'))
            controller.close()
          } catch {
            // the client cancelled (stale abort)
          }
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return `http://localhost:${server.port}`
}

describe('prefill progress and the stale-stream timer', () => {
  test('progress chunks keep a long prefill alive, and the request asks for them', async () => {
    const seen: Record<string, unknown>[] = []
    // 5 × 300 ms of prefill = 1.5 s of no tokens, against a 1 s stale timeout. The margin per
    // gap is wide on purpose: Windows loopback can hold a small write back ~200 ms.
    const url = fakeServer([300, 300, 300, 300, 300], true, seen)
    const provider = new LlamaCppProvider(url, 'plain-test-model', 1000)
    const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.content).toBe('answer')
    expect(seen[0]?.return_progress).toBe(true)
  })

  test('the same silence without progress chunks is still treated as a stall', async () => {
    const seen: Record<string, unknown>[] = []
    const url = fakeServer([300, 300, 300, 300, 300], false, seen)
    const provider = new LlamaCppProvider(url, 'plain-test-model', 1000)
    const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.content).not.toBe('answer')
  })
})
