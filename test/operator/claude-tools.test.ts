import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  createEgirlMcpServer,
  stripToolPrefix,
  toCallToolResult,
} from '../../src/operator/claude-tools'
import { createToolExecutor } from '../../src/tools/executor'
import type { ToolResult } from '../../src/tools/types'

/**
 * egirl's tools reach Claude over MCP. What matters is that the registry is served as-is
 * (names, descriptions, JSON Schema) and that a call lands on the one executor, under the
 * lock, with its result in MCP's shape.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUg=='

async function connected(args: Parameters<typeof createEgirlMcpServer>[0]): Promise<Client> {
  const server = createEgirlMcpServer(args)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(clientSide)
  return client
}

describe('createEgirlMcpServer', () => {
  test('lists the executor tools with their schemas and runs a call through the executor', async () => {
    const executor = createToolExecutor()
    const seen: unknown[] = []
    executor.register({
      definition: {
        name: 'greet',
        description: 'Say hi',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'who' } },
          required: ['name'],
        },
      },
      execute: async (params, cwd, ctx) => {
        seen.push({ params, cwd, ctx })
        return { success: true, output: `hi ${params.name}` }
      },
    })
    const locked: string[] = []
    const results: Array<{ name: string; result: ToolResult }> = []
    const client = await connected({
      executor,
      cwd: '/work',
      ctx: { sessionId: 'discord:1' },
      exclusive: async (fn) => {
        locked.push('in')
        try {
          return await fn()
        } finally {
          locked.push('out')
        }
      },
      onResult: (name, _args, result) => results.push({ name, result }),
    })

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['greet'])
    expect(tools[0]?.description).toBe('Say hi')
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', required: ['name'] })

    const res = await client.callTool({ name: 'greet', arguments: { name: 'nina' } })
    expect(res.content).toEqual([{ type: 'text', text: 'hi nina' }])
    expect(res.isError).toBeUndefined()
    expect(seen).toEqual([
      { params: { name: 'nina' }, cwd: '/work', ctx: { sessionId: 'discord:1' } },
    ])
    expect(locked).toEqual(['in', 'out'])
    expect(results).toEqual([{ name: 'greet', result: { success: true, output: 'hi nina' } }])
  })

  test('a failed tool is an MCP error result, not a thrown request', async () => {
    const executor = createToolExecutor()
    executor.register({
      definition: {
        name: 'boom',
        description: 'fails',
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => ({ success: false, output: 'nope' }),
    })
    const client = await connected({ executor, cwd: '/w', ctx: {}, exclusive: (fn) => fn() })
    const res = await client.callTool({ name: 'boom', arguments: {} })
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
