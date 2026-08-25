import { describe, expect, test } from 'bun:test'
import { createToolExecutor } from '../../src/tools/executor'
import type { Tool, ToolResult } from '../../src/tools/types'

const echoTool: Tool = {
  definition: {
    name: 'execute_command',
    description: 'Run a command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'the command' } },
      required: ['command'],
    },
  },
  async execute(params): Promise<ToolResult> {
    return { success: true, output: `ran: ${params.command}` }
  },
}

describe('executor required-parameter validation', () => {
  test('empty arguments get a crisp reissue message, not a tool crash', async () => {
    const ex = createToolExecutor()
    ex.register(echoTool)
    const r = await ex.execute({ id: 'c1', name: 'execute_command', arguments: {} }, '/tmp')
    expect(r.success).toBe(false)
    expect(r.output).toContain('Missing required parameter for execute_command: command')
    expect(r.output).toContain('"arguments": {"command":"<command>"}')
  })

  test('valid calls pass through untouched', async () => {
    const ex = createToolExecutor()
    ex.register(echoTool)
    const r = await ex.execute(
      { id: 'c2', name: 'execute_command', arguments: { command: 'pwd' } },
      '/tmp',
    )
    expect(r.success).toBe(true)
    expect(r.output).toBe('ran: pwd')
  })

  test('tools with no required params are unaffected', async () => {
    const ex = createToolExecutor()
    ex.register({
      definition: {
        name: 'no_args',
        description: 'x',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      async execute(): Promise<ToolResult> {
        return { success: true, output: 'ok' }
      },
    })
    const r = await ex.execute({ id: 'c3', name: 'no_args', arguments: {} }, '/tmp')
    expect(r.success).toBe(true)
  })
})
