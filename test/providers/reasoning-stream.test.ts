/**
 * Reasoning delivered out-of-band, as `--reasoning-format deepseek` does it.
 *
 * A reasoning model can deliberate for minutes before emitting a single content token. When the
 * server splits that deliberation into `reasoning_content` instead of inlining `<think>` tags,
 * the content stream is genuinely empty for the whole thinking phase -- so a stale-stream
 * detector that only watches `delta.content` sees a hang and aborts the generation right before
 * the answer arrives. These tests drive the real stream reader rather than re-implementing its
 * logic, because a simulation of the intended behaviour is exactly what let that bug through.
 */

import { describe, expect, test } from 'bun:test'
import { LlamaCppProvider } from '../../src/providers/llamacpp'

/** Build an SSE body from raw chunk objects, as llama.cpp frames them. */
function sseStream(chunks: object[], gapMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

const reasoning = (text: string) => ({ choices: [{ delta: { reasoning_content: text } }] })
const content = (text: string) => ({ choices: [{ delta: { content: text } }] })

/** Run one chat turn against a stubbed llama.cpp, returning the response and streamed tokens. */
async function chatAgainst(
  body: ReadableStream<Uint8Array>,
  staleMs?: number,
): Promise<{ response: Awaited<ReturnType<LlamaCppProvider['chat']>>; tokens: string[] }> {
  const realFetch = globalThis.fetch
  // @ts-expect-error test double
  globalThis.fetch = async (url: string | URL | Request) => {
    // getCapabilities probes /props before the first chat; answer it minimally.
    if (String(url).includes('/props')) {
      return new Response(JSON.stringify({ model_path: 'test.gguf' }), { status: 200 })
    }
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  const tokens: string[] = []
  try {
    const provider = new LlamaCppProvider('http://stub', 'test', staleMs)
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      onToken: (t) => tokens.push(t),
    })
    return { response, tokens }
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('out-of-band reasoning', () => {
  test('a long reasoning-only phase does not trip the stale detector', async () => {
    // Six reasoning deltas spaced wider apart than the timeout: if reasoning did not reset the
    // timer, this stream would abort. The whole bug in one assertion.
    const { response } = await chatAgainst(
      sseStream(
        [
          reasoning('We '),
          reasoning('need '),
          reasoning('to '),
          reasoning('check '),
          reasoning('this. '),
          content('391'),
        ],
        12,
      ),
      40,
    )

    // 'length' is what a stale abort reports, so anything else means the stream survived.
    expect(response.finish_reason).toBe('stop')
    expect(response.content).toBe('391')
  })

  test('reasoning is preserved rather than discarded', async () => {
    const { response } = await chatAgainst(
      sseStream([reasoning('17*20=340, '), reasoning('plus 51.'), content('391')]),
    )
    expect(response.thinking).toBe('17*20=340, plus 51.')
  })

  test('reasoning is not leaked into the content stream', async () => {
    // It goes to the thinking channel; emitting it as content would put raw deliberation in the
    // middle of the agent's answer.
    const { response, tokens } = await chatAgainst(
      sseStream([reasoning('deliberating'), content('answer')]),
    )
    expect(tokens.join('')).toBe('answer')
    expect(response.content).toBe('answer')
  })

  test('a stream that is genuinely silent still aborts', async () => {
    // The detector must keep working -- the fix is to count reasoning as activity, not to stop
    // noticing real hangs.
    const stalled = new ReadableStream<Uint8Array>({
      start() {
        /* never enqueues, never closes */
      },
    })
    const { response } = await chatAgainst(stalled, 30)
    expect(response.finish_reason).toBe('length')
  })

  test('inline <think> tags still work', async () => {
    // Servers left on the default format inline their reasoning; that path must not regress.
    const { response, tokens } = await chatAgainst(
      sseStream([content('<think>'), content('hmm'), content('</think>'), content('answer')]),
    )
    expect(tokens.join('')).toBe('answer')
    expect(response.thinking).toBe('hmm')
  })
})
