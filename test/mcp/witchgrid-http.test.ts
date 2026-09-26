/**
 * Witchgrid's control plane serves MCP over Streamable HTTP in its narrowest legal shape: every
 * reply is a buffered application/json body, there is no SSE and no Mcp-Session-Id, GET is 405,
 * and a notification gets a bodyless 202. The stdio fixture in client.test.ts never exercises that
 * transport, so this fake reproduces cp/mcp.hml's wire behaviour exactly and drives egirl's real
 * client against it.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { connectMcpServers, type McpConnection } from '../../src/mcp/client'

const JSON_HEADERS = { 'content-type': 'application/json' }

const TOOLS = [
  {
    name: 'list_nodes',
    description: 'List every registered node in the fleet.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'resolve_profile',
    description: 'Resolve a profile (or alias) to a live inference endpoint.',
    inputSchema: {
      type: 'object',
      properties: { profile: { type: 'string' } },
      required: ['profile'],
      additionalProperties: false,
    },
  },
]

interface RpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> }
}

const seen: { methods: string[]; auth: (string | null)[]; gets: number } = {
  methods: [],
  auth: [],
  gets: 0,
}

function dispatch(msg: RpcMessage): unknown {
  if (msg.method === 'initialize') {
    return {
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'witchgrid-cp', version: '0.7.0' },
    }
  }
  if (msg.method === 'tools/list') return { tools: TOOLS }
  if (msg.method === 'tools/call') {
    const profile = msg.params?.arguments?.profile
    if (profile === 'missing') {
      const body = JSON.stringify({ error: 'no running service for profile', profile })
      return { content: [{ type: 'text', text: body }], isError: true }
    }
    const body = JSON.stringify({ profile, base_url: 'http://10.0.0.20:18001' })
    return { content: [{ type: 'text', text: body }], isError: false }
  }
  return undefined
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== '/mcp') return new Response('not found', { status: 404 })
    if (req.method === 'GET') {
      seen.gets++
      return new Response('{"error":"GET not supported; POST JSON-RPC to /mcp"}', {
        status: 405,
        headers: { ...JSON_HEADERS, allow: 'POST' },
      })
    }
    seen.auth.push(req.headers.get('authorization'))
    const msg = (await req.json()) as RpcMessage
    seen.methods.push(msg.method ?? '')
    if (msg.id === undefined) return new Response('', { status: 202, headers: JSON_HEADERS })
    const result = dispatch(msg)
    const reply =
      result === undefined
        ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }
        : { jsonrpc: '2.0', id: msg.id, result }
    return new Response(JSON.stringify(reply), { status: 200, headers: JSON_HEADERS })
  },
})

const open: McpConnection[] = []
afterAll(async () => {
  await Promise.all(open.map((c) => c.close()))
  server.stop(true)
})

async function connect() {
  const r = await connectMcpServers([
    {
      name: 'witchgrid',
      url: `http://localhost:${server.port}/mcp`,
      headers: { Authorization: 'Bearer fleet-secret' },
    },
  ])
  open.push(...r.connections)
  return r
}

describe('mcp client against a Witchgrid-shaped server', () => {
  test('connects over buffered-JSON Streamable HTTP and lists tools', async () => {
    const { tools, connections } = await connect()
    expect(connections).toHaveLength(1)
    expect(tools.map((t) => t.definition.name)).toEqual([
      'witchgrid_list_nodes',
      'witchgrid_resolve_profile',
    ])
    expect(seen.methods).toContain('initialize')
    expect(seen.methods).toContain('notifications/initialized')
  })

  test('sends the configured bearer on every POST', async () => {
    await connect()
    expect(seen.auth.length).toBeGreaterThan(0)
    expect(seen.auth.every((a) => a === 'Bearer fleet-secret')).toBe(true)
  })

  test('calls a tool and returns its JSON text', async () => {
    const { tools } = await connect()
    const resolve = tools.find((t) => t.definition.name === 'witchgrid_resolve_profile')
    const r = await resolve?.execute({ profile: 'chat-qwen' }, '/tmp')
    expect(r?.success).toBe(true)
    expect(JSON.parse(r?.output ?? '{}')).toEqual({
      profile: 'chat-qwen',
      base_url: 'http://10.0.0.20:18001',
    })
  })

  test('a non-2xx wrapped handler surfaces as a failed tool call', async () => {
    const { tools } = await connect()
    const resolve = tools.find((t) => t.definition.name === 'witchgrid_resolve_profile')
    const r = await resolve?.execute({ profile: 'missing' }, '/tmp')
    expect(r?.success).toBe(false)
    expect(r?.output).toContain('no running service')
  })
})
