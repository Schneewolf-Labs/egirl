/**
 * Whether Wald proves who sent a message. With its authentication on, an unauthenticated MCP
 * request is refused, and `from_agent` comes from the sender's token; with it off, the slug is
 * whatever the sender typed. The probe asks the real server rather than trusting our config.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { probeWaldAuth } from '../../src/peers/wald-auth'

const seen: (string | null)[] = []
const serve = (status: number) =>
  Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(req.headers.get('authorization'))
      return new Response('{}', { status, headers: { 'content-type': 'application/json' } })
    },
  })
const locked = serve(401)
const open = serve(200)
const missing = serve(404)
afterAll(() => {
  for (const s of [locked, open, missing]) s.stop(true)
})

describe('probeWaldAuth', () => {
  test('a Wald that refuses an unauthenticated request has authentication on', async () => {
    const r = await probeWaldAuth({ url: `http://127.0.0.1:${locked.port}/mcp` })
    expect(r.state).toBe('on')
  })

  test('a Wald that answers without a token has authentication off', async () => {
    const r = await probeWaldAuth({ url: `http://127.0.0.1:${open.port}/mcp` })
    expect(r.state).toBe('off')
  })

  test('anything else is unknown: wrong path, unreachable, or a stdio server', async () => {
    expect((await probeWaldAuth({ url: `http://127.0.0.1:${missing.port}/mcp` })).state).toBe(
      'unknown',
    )
    expect((await probeWaldAuth({ url: 'http://127.0.0.1:9/mcp' }, 500)).state).toBe('unknown')
    expect((await probeWaldAuth({ command: 'wald-mcp' })).state).toBe('unknown')
    expect((await probeWaldAuth(undefined)).state).toBe('unknown')
  })

  test('the probe never sends the configured credential', async () => {
    seen.length = 0
    await probeWaldAuth({
      url: `http://127.0.0.1:${locked.port}/mcp`,
      headers: { Authorization: 'Bearer secret' },
    })
    expect(seen).toEqual([null])
  })
})
