/**
 * Finding the operator model through Witchgrid.
 *
 * Direct base_url when the profile is live, the auto-spawning proxy when it is not, a legible
 * failure when the control plane is down, and one re-resolve when a direct endpoint stops
 * answering because the model moved. Everything runs against real Bun.serve fakes on port 0:
 * the parts that break are URLs and connection errors, which a fetch mock would only assert.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { LlamaCppProvider } from '../../src/providers/llamacpp'
import { LlamaCppTokenizer } from '../../src/providers/llamacpp-tokenizer'
import {
  createWitchgridPromoter,
  createWitchgridReresolver,
  resolveOperatorEndpoint,
  resolveWitchgrid,
} from '../../src/providers/witchgrid'

function sseReply(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

/** A llama-server stand-in that answers chat and tokenize, and counts what it served. */
function fakeLlama(name: string, status = 200) {
  const hits: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      hits.push(path)
      if (status !== 200) return new Response('boom', { status })
      if (path === '/tokenize') return Response.json({ tokens: [1, 2, 3] })
      return sseReply(`from ${name}`)
    },
  })
  return { server, hits, url: `http://localhost:${server.port}` }
}

/**
 * A Witchgrid CP whose live location for each profile the test controls. `known` is what
 * /api/profiles/{name} knows about (defaults to the live ones); `secret` gates the read surface
 * the way WITCHGRID_AUTH_PROTECT_READ does. The proxy route answers chat like a llama-server.
 */
function fakeWitchgrid(
  live: Record<string, string | undefined>,
  opts: { known?: string[]; secret?: string } = {},
) {
  const resolves: string[] = []
  const proxied: string[] = []
  const known = new Set(opts.known ?? Object.keys(live))
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path.startsWith('/v1/llama/')) {
        proxied.push(path)
        return sseReply('from proxy')
      }
      if (opts.secret && req.headers.get('authorization') !== `Bearer ${opts.secret}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      }
      if (path.startsWith('/api/profiles/')) {
        const name = decodeURIComponent(path.slice('/api/profiles/'.length))
        return known.has(name)
          ? Response.json({ name })
          : Response.json({ error: `no such profile: ${name}` }, { status: 404 })
      }
      if (!path.startsWith('/resolve/')) return new Response('nope', { status: 404 })
      const profile = decodeURIComponent(path.slice('/resolve/'.length))
      resolves.push(profile)
      const baseUrl = live[profile]
      if (!baseUrl) {
        return Response.json(
          { error: 'no running service for profile', profile, alias: profile },
          { status: 404 },
        )
      }
      const u = new URL(baseUrl)
      return Response.json({
        profile,
        alias: profile,
        host: u.hostname,
        port: Number(u.port),
        base_url: baseUrl,
      })
    },
  })
  return { server, resolves, proxied, url: `http://localhost:${server.port}` }
}

/** A port that nothing listens on: bind one, then release it. */
function deadUrl(): string {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') })
  const url = `http://localhost:${s.port}`
  s.stop(true)
  return url
}

const cleanup: Array<{ stop(force?: boolean): void }> = []
afterAll(() => {
  for (const s of cleanup) s.stop(true)
})

async function chatText(provider: LlamaCppProvider): Promise<string> {
  const r = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] })
  return r.content
}

describe('resolveWitchgrid', () => {
  test('a live profile resolves to its direct base_url', async () => {
    const llama = fakeLlama('a')
    const wg = fakeWitchgrid({ 'chat-qwen': `${llama.url}/` })
    cleanup.push(llama.server, wg.server)

    const r = await resolveWitchgrid({ url: `${wg.url}/`, profile: 'chat-qwen' })
    expect(r).toEqual({ kind: 'direct', baseUrl: llama.url })
  })

  test('nothing running falls back to the auto-spawning proxy', async () => {
    const wg = fakeWitchgrid({}, { known: ['chat-qwen'] })
    cleanup.push(wg.server)

    const r = await resolveWitchgrid({ url: wg.url, profile: 'chat-qwen' })
    expect(r).toEqual({ kind: 'proxy', baseUrl: `${wg.url}/v1/llama/chat-qwen` })
  })

  test('an unexpected status is an error, not a proxy fallback', async () => {
    const cp = Bun.serve({ port: 0, fetch: () => new Response('down', { status: 503 }) })
    cleanup.push(cp)
    await expect(
      resolveWitchgrid({ url: `http://localhost:${cp.port}`, profile: 'x' }),
    ).rejects.toThrow('503')
  })
})

describe('resolve with a protected read surface', () => {
  test('sends the shared secret as a bearer', async () => {
    const wg = fakeWitchgrid({ p: 'http://10.0.0.20:18001' }, { secret: 's3cret' })
    cleanup.push(wg.server)
    const r = await resolveWitchgrid({ url: wg.url, profile: 'p', token: 's3cret' })
    expect(r).toEqual({ kind: 'direct', baseUrl: 'http://10.0.0.20:18001' })
  })

  test('a 401 says which secret is missing', async () => {
    const wg = fakeWitchgrid({ p: 'http://10.0.0.20:18001' }, { secret: 's3cret' })
    cleanup.push(wg.server)
    await expect(resolveWitchgrid({ url: wg.url, profile: 'p' })).rejects.toThrow(
      /401.*WITCHGRID_SHARED_SECRET/,
    )
  })
})

describe('an unknown profile', () => {
  test('is an error naming the profile, not a silent proxy fallback', async () => {
    const wg = fakeWitchgrid({}, { known: ['chat-qwen'] })
    cleanup.push(wg.server)
    await expect(resolveWitchgrid({ url: wg.url, profile: 'chat-qwne' })).rejects.toThrow(
      /no profile named 'chat-qwne'/,
    )
  })

  test('fails startup when there is no explicit endpoint to fall back to', async () => {
    const wg = fakeWitchgrid({}, { known: ['chat-qwen'] })
    cleanup.push(wg.server)
    await expect(resolveOperatorEndpoint({ url: wg.url, profile: 'chat-qwne' })).rejects.toThrow(
      /no profile named 'chat-qwne'/,
    )
  })
})

describe('leaving the proxy once the model is up', () => {
  test('the next request after the interval goes to the direct address', async () => {
    const direct = fakeLlama('direct')
    const live: Record<string, string | undefined> = {}
    const wg = fakeWitchgrid(live, { known: ['p'] })
    cleanup.push(direct.server, wg.server)
    const target = { url: wg.url, profile: 'p' }

    const holder = { endpoint: await resolveOperatorEndpoint(target) }
    expect(holder.endpoint).toBe(`${wg.url}/v1/llama/p`)
    const provider = new LlamaCppProvider(
      holder.endpoint,
      'test',
      undefined,
      undefined,
      undefined,
      undefined,
      createWitchgridReresolver(target, holder),
      createWitchgridPromoter(target, holder, 0),
    )

    // The first request through the proxy is what has Witchgrid spawn the model.
    expect(await chatText(provider)).toBe('from proxy')
    live.p = direct.url
    expect(await chatText(provider)).toBe('from direct')
    expect(holder.endpoint).toBe(direct.url)
    expect(wg.proxied).toHaveLength(1)
  })

  test('checks at most once per interval while still on the proxy', async () => {
    const wg = fakeWitchgrid({}, { known: ['p'] })
    cleanup.push(wg.server)
    const target = { url: wg.url, profile: 'p' }
    const holder = { endpoint: `${wg.url}/v1/llama/p` }
    const promote = createWitchgridPromoter(target, holder, 60_000)

    expect(await promote()).toBeUndefined()
    expect(await promote()).toBeUndefined()
    expect(wg.resolves).toHaveLength(1)
  })

  test('does nothing on a direct endpoint', async () => {
    const wg = fakeWitchgrid({ p: 'http://10.0.0.20:18001' })
    cleanup.push(wg.server)
    const holder = { endpoint: 'http://10.0.0.20:18001' }
    const promote = createWitchgridPromoter({ url: wg.url, profile: 'p' }, holder, 0)

    expect(await promote()).toBeUndefined()
    expect(wg.resolves).toHaveLength(0)
  })
})

describe('resolveOperatorEndpoint', () => {
  test('an unreachable control plane fails startup and says what to do', async () => {
    const target = { url: deadUrl(), profile: 'chat-qwen' }
    await expect(resolveOperatorEndpoint(target)).rejects.toThrow(
      /\[local.witchgrid\] could not resolve profile 'chat-qwen'/,
    )
  })

  test('an unreachable control plane uses an explicitly configured endpoint', async () => {
    const target = { url: deadUrl(), profile: 'chat-qwen' }
    expect(await resolveOperatorEndpoint(target, 'http://gpu-box:8080')).toBe('http://gpu-box:8080')
  })

  test('a reachable control plane wins over the configured endpoint', async () => {
    const wg = fakeWitchgrid({ 'chat-qwen': 'http://10.0.0.20:18001' })
    cleanup.push(wg.server)
    const target = { url: wg.url, profile: 'chat-qwen' }
    expect(await resolveOperatorEndpoint(target, 'http://gpu-box:8080')).toBe(
      'http://10.0.0.20:18001',
    )
  })
})

describe('re-resolving a moved endpoint', () => {
  test('a refused connection re-resolves once and retries at the new address', async () => {
    const moved = fakeLlama('moved')
    const wg = fakeWitchgrid({ 'chat-qwen': moved.url })
    cleanup.push(moved.server, wg.server)

    const holder = { endpoint: deadUrl() }
    const reresolve = createWitchgridReresolver({ url: wg.url, profile: 'chat-qwen' }, holder)
    const provider = new LlamaCppProvider(
      holder.endpoint,
      'test',
      undefined,
      undefined,
      undefined,
      undefined,
      reresolve,
    )

    expect(await chatText(provider)).toBe('from moved')
    expect(holder.endpoint).toBe(moved.url)
    expect(wg.resolves).toEqual(['chat-qwen'])

    // The provider stays on the new address; no lookup per request.
    expect(await chatText(provider)).toBe('from moved')
    expect(wg.resolves).toEqual(['chat-qwen'])
  })

  test('a model that is gone everywhere moves to the proxy', async () => {
    const wg = fakeWitchgrid({}, { known: ['chat-qwen'] })
    cleanup.push(wg.server)
    const holder = { endpoint: deadUrl() }
    const reresolve = createWitchgridReresolver({ url: wg.url, profile: 'chat-qwen' }, holder)

    expect(await reresolve()).toBe(`${wg.url}/v1/llama/chat-qwen`)
    expect(holder.endpoint).toBe(`${wg.url}/v1/llama/chat-qwen`)
  })

  test('concurrent failures share one lookup', async () => {
    const wg = fakeWitchgrid({ p: 'http://10.0.0.21:18002' })
    cleanup.push(wg.server)
    const reresolve = createWitchgridReresolver({ url: wg.url, profile: 'p' }, { endpoint: 'x' })

    await Promise.all([reresolve(), reresolve(), reresolve()])
    expect(wg.resolves).toHaveLength(1)
  })

  test('an HTTP error from a reachable server does not re-resolve', async () => {
    const broken = fakeLlama('broken', 500)
    const wg = fakeWitchgrid({ 'chat-qwen': 'http://elsewhere:1' })
    cleanup.push(broken.server, wg.server)

    const holder = { endpoint: broken.url }
    const reresolve = createWitchgridReresolver({ url: wg.url, profile: 'chat-qwen' }, holder)
    const provider = new LlamaCppProvider(
      broken.url,
      'test',
      undefined,
      undefined,
      undefined,
      undefined,
      reresolve,
    )

    await expect(chatText(provider)).rejects.toThrow()
    expect(wg.resolves).toEqual([])
    expect(holder.endpoint).toBe(broken.url)
  })

  test('without a re-resolver a dead endpoint just fails', async () => {
    const provider = new LlamaCppProvider(deadUrl(), 'test')
    await expect(chatText(provider)).rejects.toThrow()
  })

  test('the tokenizer follows the endpoint once it moves', async () => {
    const moved = fakeLlama('moved')
    cleanup.push(moved.server)
    const holder = { endpoint: deadUrl() }
    const tokenizer = new LlamaCppTokenizer(() => holder.endpoint)

    holder.endpoint = moved.url
    expect(await tokenizer.countTokens('hello there')).toBe(3)
    expect(moved.hits).toContain('/tokenize')
  })
})
