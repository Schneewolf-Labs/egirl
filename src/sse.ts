/**
 * Server-Sent Events response with a keepalive, for every route that streams a run.
 *
 * No byte flows during a big prefill (minutes before the first token) or while a long tool runs
 * mid-turn, and with nothing on the wire the connection idles out — Bun's own timeout, and any
 * proxy in between. An SSE comment is ignored by the client's parser but resets every idle
 * timer, so the stream survives an arbitrarily long gap anywhere in the turn. Sent only when
 * the wire has actually been quiet, so real output is never delayed by it.
 */

const KEEPALIVE_MS = 4000

/**
 * Build the response. `run` receives `send` (one `data:` frame per call) and `closed`, which
 * fires when the client goes away — a spectator that navigates off must release its
 * subscription, not sit on it until the run ends. Every enqueue is guarded: a late token after
 * the client left must not crash the run that is still finishing server-side.
 */
export function sseResponse(
  run: (send: (frame: unknown) => void, closed: AbortSignal) => Promise<void>,
  options: { signal?: AbortSignal } = {},
): Response {
  const enc = new TextEncoder()
  const closed = new AbortController()
  options.signal?.addEventListener('abort', () => closed.abort(), { once: true })
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastByteAt = Date.now()
      const write = (s: string) => {
        try {
          controller.enqueue(enc.encode(s))
          lastByteAt = Date.now()
        } catch {}
      }
      const keepalive = setInterval(() => {
        if (Date.now() - lastByteAt < KEEPALIVE_MS) return
        write(': keepalive\n\n')
      }, KEEPALIVE_MS)
      // Headers don't leave the server until the body has a byte, so a client would sit on
      // `fetch()` until the first token or keepalive. A comment opens the stream at once.
      write(': open\n\n')
      try {
        await run((frame) => write(`data: ${JSON.stringify(frame)}\n\n`), closed.signal)
      } finally {
        clearInterval(keepalive)
        try {
          controller.close()
        } catch {}
      }
    },
    cancel() {
      closed.abort()
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}
