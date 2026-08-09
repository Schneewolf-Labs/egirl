import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PEER_PROTOCOL, type PeerMessageRequest } from '../../src/peers/protocol'
import { createPeerTools } from '../../src/tools/builtin/peers'

describe('peer tools', () => {
  const port = 3997
  const base = `http://127.0.0.1:${port}`
  let server: ReturnType<typeof Bun.serve>
  let lastRequest: { auth: string | null; body: PeerMessageRequest } | undefined

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/peer/identity') {
          return Response.json({ service: 'egirl', protocol: PEER_PROTOCOL, name: 'luna' })
        }
        if (url.pathname === '/peer/message' && req.method === 'POST') {
          const body = (await req.json()) as PeerMessageRequest
          lastRequest = { auth: req.headers.get('authorization'), body }
          if (body.message === 'slow') {
            await new Promise((r) => setTimeout(r, 500))
          }
          return Response.json({
            protocol: PEER_PROTOCOL,
            from: 'luna',
            content: `luna saw: ${body.message}`,
            session_id: `peer:${body.from}`,
          })
        }
        return new Response('not found', { status: 404 })
      },
    })
  })

  afterAll(() => {
    server.stop(true)
  })

  const tools = createPeerTools({
    selfName: 'kira',
    peers: [
      { name: 'luna', url: base, token: 'peer-secret', timeoutMs: 5000 },
      { name: 'offline', url: 'http://127.0.0.1:1', timeoutMs: 200 },
    ],
  })

  test('peer_message sends protocol envelope and returns the reply', async () => {
    const result = await tools.peerMessageTool.execute({ peer: 'luna', message: 'hello' }, '.')
    expect(result.success).toBe(true)
    expect(result.output).toContain('luna replied:')
    expect(result.output).toContain('luna saw: hello')
    expect(lastRequest?.body.protocol).toBe(PEER_PROTOCOL)
    expect(lastRequest?.body.from).toBe('kira')
    expect(lastRequest?.auth).toBe('Bearer peer-secret')
  })

  test('peer_message matches peer names case-insensitively', async () => {
    const result = await tools.peerMessageTool.execute({ peer: 'LUNA', message: 'hi' }, '.')
    expect(result.success).toBe(true)
  })

  test('peer_message rejects unknown peers and lists configured ones', async () => {
    const result = await tools.peerMessageTool.execute({ peer: 'nyx', message: 'hi' }, '.')
    expect(result.success).toBe(false)
    expect(result.output).toContain('Unknown peer "nyx"')
    expect(result.output).toContain('luna')
  })

  test('peer_message requires peer and message', async () => {
    const result = await tools.peerMessageTool.execute({ peer: 'luna' }, '.')
    expect(result.success).toBe(false)
  })

  test('peer_message times out without throwing', async () => {
    const result = await tools.peerMessageTool.execute(
      { peer: 'luna', message: 'slow', timeout_ms: 50 },
      '.',
    )
    expect(result.success).toBe(false)
    expect(result.output).toContain('did not reply within 50ms')
  })

  test('peer_message reports unreachable peers as failure', async () => {
    const result = await tools.peerMessageTool.execute({ peer: 'offline', message: 'hi' }, '.')
    expect(result.success).toBe(false)
    expect(result.output).toContain('offline')
  })

  test('peer_list reports online and unreachable peers', async () => {
    const result = await tools.peerListTool.execute({}, '.')
    expect(result.success).toBe(true)
    expect(result.output).toContain(`luna — ${base} — online as "luna" (${PEER_PROTOCOL})`)
    expect(result.output).toContain('offline — http://127.0.0.1:1 — unreachable')
  })
})
