/**
 * MCP tools must be indistinguishable from builtin tools, and a broken server must be survivable.
 *
 * Those two properties are the whole design. If an MCP tool arrives at the executor in the same
 * shape as `read_file`, then safety, energy, permissions and the prompt all treat it identically
 * and nothing downstream needs to know MCP exists. And since these are other people's processes
 * and network endpoints, "the server is down" has to cost its own tools and nothing else --
 * otherwise adding a second server makes the agent strictly less reliable.
 *
 * Exercised against a real MCP server over stdio rather than a mocked client, because the parts
 * most likely to break are the transport and the schema hand-off, and a mock would assert my
 * assumptions about the SDK rather than the SDK's behaviour.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { connectMcpServers, type McpConnection } from '../../src/mcp/client'

const SDK = join(import.meta.dir, '../../node_modules/@modelcontextprotocol/sdk/dist/esm')

const SERVER = `
import { Server } from '${SDK}/server/index.js'
import { StdioServerTransport } from '${SDK}/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '${SDK}/types.js'

const server = new Server({ name: 'fixture', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'Echo a message.',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } },
    { name: 'noargs', description: 'Takes nothing.', inputSchema: { type: 'object', properties: {} } },
    { name: 'boom', description: 'Reports an error.', inputSchema: { type: 'object', properties: {} } },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'boom') {
    return { content: [{ type: 'text', text: 'deliberate failure' }], isError: true }
  }
  if (req.params.name === 'noargs') return { content: [{ type: 'text', text: 'ok' }] }
  return { content: [{ type: 'text', text: 'echo:' + (req.params.arguments?.msg ?? '') }] }
})

await server.connect(new StdioServerTransport())
`

const dir = mkdtempSync(join(tmpdir(), 'egirl-mcp-'))
const serverPath = join(dir, 'server.mjs')
writeFileSync(serverPath, SERVER)

const open: McpConnection[] = []
afterAll(async () => {
  await Promise.all(open.map((c) => c.close()))
})

async function connect(extra: Array<Record<string, unknown>> = []) {
  const r = await connectMcpServers([
    { name: 'fixture', command: 'node', args: [serverPath] },
    ...(extra as never[]),
  ])
  open.push(...r.connections)
  return r
}

describe('mcp client', () => {
  test('exposes server tools namespaced by server name', async () => {
    const { tools } = await connect()
    const names = tools.map((t) => t.definition.name)
    // Two servers offering `search` would otherwise silently shadow each other.
    expect(names).toContain('fixture_echo')
    expect(names).toContain('fixture_boom')
  })

  test('passes the JSON Schema through unchanged', async () => {
    const { tools } = await connect()
    const echo = tools.find((t) => t.definition.name === 'fixture_echo')
    expect(echo?.definition.parameters).toEqual({
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
    })
  })

  test('calls a tool and returns its text', async () => {
    const { tools } = await connect()
    const echo = tools.find((t) => t.definition.name === 'fixture_echo')
    const r = await echo?.execute({ msg: 'hello' }, '/tmp')
    expect(r?.success).toBe(true)
    expect(r?.output).toContain('echo:hello')
  })

  test('a tool taking no arguments still gets a valid schema', async () => {
    // A missing `parameters` renders as a malformed tool definition to the model.
    const { tools } = await connect()
    const noargs = tools.find((t) => t.definition.name === 'fixture_noargs')
    expect(noargs?.definition.parameters).toBeDefined()
    const r = await noargs?.execute({}, '/tmp')
    expect(r?.success).toBe(true)
  })

  test('isError is a failure, not a success with sad text', async () => {
    // MCP reports tool-level failure in-band; it is not an exception.
    const { tools } = await connect()
    const boom = tools.find((t) => t.definition.name === 'fixture_boom')
    const r = await boom?.execute({}, '/tmp')
    expect(r?.success).toBe(false)
    expect(r?.output).toContain('deliberate failure')
  })

  test('an unreachable server costs only its own tools', async () => {
    const { tools } = await connect([{ name: 'dead', command: 'this-binary-does-not-exist' }])
    expect(tools.some((t) => t.definition.name.startsWith('fixture_'))).toBe(true)
    expect(tools.some((t) => t.definition.name.startsWith('dead_'))).toBe(false)
  })

  test('a server with neither url nor command is skipped, not thrown', async () => {
    const { tools } = await connect([{ name: 'empty' }])
    expect(tools.some((t) => t.definition.name.startsWith('fixture_'))).toBe(true)
  })

  test('no servers configured is not an error', async () => {
    const { tools, connections } = await connectMcpServers([])
    expect(tools).toEqual([])
    expect(connections).toEqual([])
  })
})
