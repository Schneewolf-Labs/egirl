import { describe, expect, test } from 'bun:test'
import { LlamaCppProvider } from '../../src/providers/llamacpp'

/**
 * `[local] max_concurrent` used to be parsed and never read. These pin that it now actually
 * bounds in-flight requests, because the failure it prevents is invisible until a serial
 * engine is under load: extra requests queue server-side and expire on the stale-stream
 * timeout instead of waiting here.
 */
function stubFetch(onCall: () => void, release: Promise<void>) {
  return async (_url: unknown, _init?: unknown) => {
    onCall()
    await release
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

async function runConcurrent(maxConcurrent: number, requests: number) {
  const original = globalThis.fetch
  let inFlight = 0
  let peak = 0
  let unblock: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  globalThis.fetch = stubFetch(
    () => {
      inFlight++
      peak = Math.max(peak, inFlight)
    },
    gate.then(() => {
      inFlight--
    }),
  ) as typeof fetch

  try {
    const p = new LlamaCppProvider('http://localhost:1', 'test', 60_000, maxConcurrent)
    const all = Promise.all(
      Array.from({ length: requests }, () =>
        p.chat({ messages: [{ role: 'user', content: 'hi' }] } as never),
      ),
    )
    // let every call that is allowed to start, start
    await new Promise((r) => setTimeout(r, 20))
    const observed = peak
    unblock()
    await all
    return observed
  } finally {
    globalThis.fetch = original
  }
}

describe('local max_concurrent', () => {
  test('bounds in-flight requests to the configured limit', async () => {
    expect(await runConcurrent(2, 6)).toBe(2)
  })

  test('a limit of 1 serializes, which is what a serial engine needs', async () => {
    expect(await runConcurrent(1, 4)).toBe(1)
  })

  test('0 means unlimited, for a server with parallel slots', async () => {
    expect(await runConcurrent(0, 5)).toBe(5)
  })
})
