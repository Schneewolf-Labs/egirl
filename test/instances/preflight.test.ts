/**
 * Instance preflight.
 *
 * These checks exist because the failures they catch are quiet ones. An embeddings service that
 * is down does not raise anything — memory just stops working. A config `model` that no longer
 * matches the weights on the other end does not raise anything either; it produces benchmark
 * numbers attributed to the wrong model.
 *
 * Servers are real rather than mocked: the thing being tested is how the check reacts to an HTTP
 * boundary, so faking the boundary would test the wrong half.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import type { RuntimeConfig } from '../../src/config'
import {
  checkApiPort,
  checkEmbeddings,
  checkMcpServers,
  checkServedModel,
} from '../../src/instances/preflight'

function serve(handler: (req: Request) => Response): { url: string; stop: () => void } {
  const server = Bun.serve({ port: 0, fetch: handler })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const servers: Array<{ stop: () => void }> = []
afterAll(() => {
  for (const server of servers) server.stop()
})

function track<T extends { stop: () => void }>(server: T): T {
  servers.push(server)
  return server
}

function configWith(overrides: Record<string, unknown>): RuntimeConfig {
  return {
    local: { endpoint: 'http://127.0.0.1:1', model: 'test-model', ...overrides },
    channels: {},
  } as unknown as RuntimeConfig
}

describe('checkServedModel', () => {
  test('reports the served model when it matches the config', async () => {
    const server = track(
      serve(() => Response.json({ data: [{ id: '/models/wichtel-qwen3.6-27b-q8_0.gguf' }] })),
    )
    const result = await checkServedModel(
      configWith({ endpoint: server.url, model: 'wichtel-qwen3.6-27b-q8_0' }),
    )
    expect(result.level).toBe('ok')
    expect(result.message).toContain('wichtel')
  })

  test('warns when the endpoint is serving something else entirely', async () => {
    // The failure this exists for: config says one model, the box is holding another, and every
    // number you collect is attributed to the wrong weights.
    const server = track(serve(() => Response.json({ data: [{ id: '/gguf/huihui-q8_0.gguf' }] })))
    const result = await checkServedModel(
      configWith({ endpoint: server.url, model: 'wichtel-qwen3.6-27b-q8_0' }),
    )
    expect(result.level).toBe('warn')
    expect(result.message).toContain('huihui')
    expect(result.message).toContain('wichtel')
  })

  test('tolerates a nickname that is not the filename', async () => {
    // Config names are nicknames the server never sees; a strict comparison would warn forever.
    const server = track(
      serve(() => Response.json({ data: [{ id: '/x/Hemlock-Qwen3.8-27B-Q8_0.gguf' }] })),
    )
    const result = await checkServedModel(
      configWith({ endpoint: server.url, model: 'hemlock-qwen3.8-27b-q8_0' }),
    )
    expect(result.level).toBe('ok')
  })

  test('an endpoint naming no model is a warning, not a crash', async () => {
    const server = track(serve(() => Response.json({ data: [] })))
    const result = await checkServedModel(configWith({ endpoint: server.url }))
    expect(result.level).toBe('warn')
  })

  test('an unreachable endpoint fails rather than throwing', async () => {
    const result = await checkServedModel(configWith({ endpoint: 'http://127.0.0.1:1' }))
    expect(result.level).toBe('fail')
  })
})

describe('checkEmbeddings', () => {
  test('is skipped entirely when memory is not configured', async () => {
    expect(await checkEmbeddings(configWith({}))).toBeUndefined()
  })

  test('fails loudly when the service is down, and says what breaks', async () => {
    const config = configWith({
      embeddings: {
        provider: 'qwen3-vl',
        endpoint: 'http://127.0.0.1:1',
        model: 'e',
        dimensions: 2048,
        multimodal: true,
      },
    })
    const result = await checkEmbeddings(config)
    expect(result?.level).toBe('fail')
    expect(result?.message).toContain('memory will not work')
  })

  test('passes when the service answers', async () => {
    const server = track(serve(() => Response.json({ status: 'healthy' })))
    const config = configWith({
      embeddings: {
        provider: 'qwen3-vl',
        endpoint: server.url,
        model: 'qwen3-vl-embedding-2b',
        dimensions: 2048,
        multimodal: true,
      },
    })
    expect((await checkEmbeddings(config))?.level).toBe('ok')
  })
})

describe('checkMcpServers', () => {
  test('a 4xx still counts as reachable', async () => {
    // A bare GET is not a valid MCP session, so the server is entitled to reject it. Only a
    // transport failure means nothing is there.
    const server = track(serve(() => new Response('no session', { status: 400 })))
    const config = { mcp: { servers: [{ name: 'wald', url: server.url }] } } as RuntimeConfig
    const results = await checkMcpServers(config)
    expect(results[0]?.level).toBe('ok')
  })

  test('an unreachable server fails', async () => {
    const config = {
      mcp: { servers: [{ name: 'wald', url: 'http://127.0.0.1:1/mcp' }] },
    } as RuntimeConfig
    expect((await checkMcpServers(config))[0]?.level).toBe('fail')
  })

  test('stdio servers are reported but never spawned', async () => {
    const config = {
      mcp: { servers: [{ name: 'local', command: 'some-binary' }] },
    } as RuntimeConfig
    const results = await checkMcpServers(config)
    expect(results[0]?.level).toBe('ok')
    expect(results[0]?.message).toContain('not probed')
  })
})

describe('checkApiPort', () => {
  test('is skipped when the instance exposes no API', async () => {
    expect(await checkApiPort(configWith({}))).toBeUndefined()
  })

  test('warns when the port is already bound, naming both readings', async () => {
    const server = track(serve(() => new Response('x')))
    const port = Number(new URL(server.url).port)
    const config = { local: {}, channels: { api: { host: '127.0.0.1', port } } } as RuntimeConfig
    const result = await checkApiPort(config)
    expect(result?.level).toBe('warn')
    expect(result?.message).toContain('already running')
  })
})
