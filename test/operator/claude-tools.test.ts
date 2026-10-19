import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  createEgirlMcpServer,
  stripToolPrefix,
  toCallToolResult,
} from '../../src/operator/claude-tools'
import type { ServedTool } from '../../src/operator/hosted-types'
import type { ToolDefinition } from '../../src/providers/types'

/**
 * egirl's tools reach Claude over MCP. What matters is that the turn's tools are served as-is
 * (names, descriptions, JSON Schema), that a call lands on the hosted session's server, and
 * that what comes back is in MCP's shape, with the session's note after it.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUg=='

const greet: ToolDefinition = {
  name: 'greet',
  description: 'Say hi',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'who' } },
    required: ['name'],
  },
}

async function connected(
  tools: ToolDefinition[],
  call: (name: string, args: Record<string, unknown>) => Promise<ServedTool>,
): Promise<Client> {
  const server = createEgirlMcpServer(tools, call)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(clientSide)
  return client
}

describe('createEgirlMcpServer', () => {
  test('lists the turn tools with their schemas and hands each call to the session', async () => {
    const calls: unknown[] = []
    const client = await connected([greet], async (name, args) => {
      calls.push({ name, args })
      return { result: { success: true, output: `hi ${args.name}` } }
    })

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['greet'])
    expect(tools[0]?.description).toBe('Say hi')
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', required: ['name'] })

    const res = await client.callTool({ name: 'greet', arguments: { name: 'nina' } })
    expect(res.content).toEqual([{ type: 'text', text: 'hi nina' }])
    expect(res.isError).toBeUndefined()
    expect(calls).toEqual([{ name: 'greet', args: { name: 'nina' } }])
  })

  test("the session's note rides after the result", async () => {
    const client = await connected([greet], async () => ({
      result: { success: true, output: 'ok' },
      note: 'wrap up now',
    }))
    const res = await client.callTool({ name: 'greet', arguments: { name: 'x' } })
    expect(res.content).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'text', text: 'wrap up now' },
    ])
  })

  test('a failed tool is an MCP error result, not a thrown request', async () => {
    const client = await connected([greet], async () => ({
      result: { success: false, output: 'nope' },
    }))
    const res = await client.callTool({ name: 'greet', arguments: {} })
    expect(res.isError).toBe(true)
    expect(res.content).toEqual([{ type: 'text', text: 'nope' }])
  })
})

describe('toCallToolResult', () => {
  test('an image result becomes an image block Claude can see', () => {
    const r = toCallToolResult({
      success: true,
      output: `data:image/png;base64,${PNG}`,
      isImage: true,
    })
    expect(r.content).toEqual([{ type: 'image', data: PNG, mimeType: 'image/png' }])
  })

  test('empty output is still a text block', () => {
    expect(toCallToolResult({ success: true, output: '' }).content).toEqual([
      { type: 'text', text: '(no output)' },
    ])
  })
})

describe('stripToolPrefix', () => {
  test('takes the SDK prefix off and leaves other names alone', () => {
    expect(stripToolPrefix('mcp__egirl__read_file')).toBe('read_file')
    expect(stripToolPrefix('read_file')).toBe('read_file')
    expect(stripToolPrefix('mcp__other__x')).toBe('mcp__other__x')
  })
})
