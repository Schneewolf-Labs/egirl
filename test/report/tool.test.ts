import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PEER_PROTOCOL, type PeerMessageRequest } from '../../src/peers/protocol'
import { ReplyBroker } from '../../src/report/broker'
import { createReportTool, parseReportTarget } from '../../src/report/tool'

describe('parseReportTarget', () => {
  test('parses peer, xmpp and discord targets', () => {
    expect(parseReportTarget('peer:hermes')).toEqual({
      kind: 'peer',
      channel: 'hermes',
      target: '',
    })
    expect(parseReportTarget('xmpp:boss@example.com')).toEqual({
      kind: 'channel',
      channel: 'xmpp',
      target: 'boss@example.com',
    })
    expect(parseReportTarget('discord:12345')).toEqual({
      kind: 'channel',
      channel: 'discord',
      target: '12345',
    })
  })

  test('rejects malformed targets', () => {
    expect(parseReportTarget('hermes')).toBeUndefined()
    expect(parseReportTarget('peer:')).toBeUndefined()
    expect(parseReportTarget(':x')).toBeUndefined()
  })
})

describe('report tool — channel target', () => {
  function makeChannelTool(broker?: ReplyBroker) {
    const sent: Array<{ target: string; message: string }> = []
    const outbound = new Map([
      [
        'xmpp',
        {
          send: async (target: string, message: string) => {
            sent.push({ target, message })
          },
        },
      ],
    ])
    const target = parseReportTarget('xmpp:boss@example.com')
    if (!target) throw new Error('unreachable')
    const tool = createReportTool({
      to: target,
      toRaw: 'xmpp:boss@example.com',
      selfName: 'zero',
      peers: [],
      outbound,
      broker,
      askTimeoutMs: 5000,
    })
    return { tool, sent }
  }

  test('notify sends one-way and returns immediately', async () => {
    const { tool, sent } = makeChannelTool()
    const result = await tool.execute({ mode: 'notify', message: 'goal exhausted' }, '.')
    expect(result.success).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.target).toBe('boss@example.com')
    expect(sent[0]?.message).toContain('goal exhausted')
    expect(sent[0]?.message).toContain('[report from zero]')
  })

  test('ask blocks until the broker delivers the reply', async () => {
    const broker = new ReplyBroker()
    const { tool, sent } = makeChannelTool(broker)
    const pending = tool.execute({ mode: 'ask', message: 'DX9 or DX11?' }, '.')
    // Let the send happen, then answer as the human would.
    await new Promise((r) => setTimeout(r, 10))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.message).toContain('(awaiting your reply)')
    expect(broker.tryDeliver('xmpp', 'boss@example.com', 'DX9')).toBe(true)
    const result = await pending
    expect(result.success).toBe(true)
    expect(result.output).toContain('DX9')
  })

  test('ask timeout tells the agent to park, not fail silently', async () => {
    const broker = new ReplyBroker()
    const { tool } = makeChannelTool(broker)
    const result = await tool.execute({ mode: 'ask', message: 'anyone?', timeout_ms: 20 }, '.')
    expect(result.success).toBe(false)
    expect(result.output).toContain('durable notes')
  })

  test('ask without a broker degrades with an explanation', async () => {
    const { tool } = makeChannelTool(undefined)
    const result = await tool.execute({ mode: 'ask', message: 'anyone?' }, '.')
    expect(result.success).toBe(false)
    expect(result.output).toContain('mode=ask is not available')
  })

  test('validates mode and message', async () => {
    const { tool } = makeChannelTool()
    expect((await tool.execute({ mode: 'shout', message: 'x' }, '.')).success).toBe(false)
    expect((await tool.execute({ mode: 'notify' }, '.')).success).toBe(false)
  })
})

describe('report tool — peer target', () => {
  const port = 3990
  const base = `http://127.0.0.1:${port}`
  let server: ReturnType<typeof Bun.serve>
  const received: PeerMessageRequest[] = []

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/peer/message' && req.method === 'POST') {
          const body = (await req.json()) as PeerMessageRequest
          received.push(body)
          if (body.message.includes('slow')) await new Promise((r) => setTimeout(r, 300))
          return Response.json({
            protocol: PEER_PROTOCOL,
            from: 'hermes',
            content: `supervisor says: proceed`,
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

  function makePeerTool() {
    const target = parseReportTarget('peer:hermes')
    if (!target) throw new Error('unreachable')
    return createReportTool({
      to: target,
      toRaw: 'peer:hermes',
      selfName: 'zero',
      peers: [{ name: 'hermes', url: base, timeoutMs: 5000 }],
      outbound: new Map(),
      askTimeoutMs: 5000,
    })
  }

  test('ask rides the peer protocol and returns the reply', async () => {
    const tool = makePeerTool()
    const result = await tool.execute({ mode: 'ask', message: 'what next?' }, '.')
    expect(result.success).toBe(true)
    expect(result.output).toContain('supervisor says: proceed')
    const last = received[received.length - 1]
    expect(last?.from).toBe('zero')
    expect(last?.message).toContain('[report:ask]')
    expect(last?.message).toContain('what next?')
  })

  test('notify does not wait for the supervisor agent', async () => {
    const tool = makePeerTool()
    const started = Date.now()
    const result = await tool.execute({ mode: 'notify', message: 'slow milestone' }, '.')
    expect(result.success).toBe(true)
    // The stub peer takes 300ms on this message; notify must return well before that.
    expect(Date.now() - started).toBeLessThan(200)
    // Give the background send time to land for the next assertion.
    await new Promise((r) => setTimeout(r, 400))
    expect(received.some((r) => r.message.includes('slow milestone'))).toBe(true)
  })

  test('unknown peer target errors cleanly', async () => {
    const target = parseReportTarget('peer:ghost')
    if (!target) throw new Error('unreachable')
    const tool = createReportTool({
      to: target,
      toRaw: 'peer:ghost',
      selfName: 'zero',
      peers: [],
      outbound: new Map(),
      askTimeoutMs: 5000,
    })
    const result = await tool.execute({ mode: 'ask', message: 'hello?' }, '.')
    expect(result.success).toBe(false)
    expect(result.output).toContain('not among the configured peers')
  })
})
