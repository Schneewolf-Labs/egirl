import type { Tool, ToolResult, ToolDefinition } from './types'
import type { ToolCall } from '../providers/types'
import { log } from '../util/logger'

export class ToolExecutor {
  private tools: Map<string, Tool> = new Map()

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool)
    log.debug('tools', `Registered tool: ${tool.definition.name}`)
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition)
  }

  async execute(call: ToolCall, cwd: string): Promise<ToolResult> {
    const tool = this.tools.get(call.name)

    if (!tool) {
      return {
        success: false,
        output: `Unknown tool: ${call.name}`,
      }
    }

    log.debug('tools', `Executing tool: ${call.name}`, call.arguments)

    try {
      const result = await tool.execute(call.arguments, cwd)
      log.debug('tools', `Tool ${call.name} completed:`, {
        success: result.success,
        outputLength: result.output.length,
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('tools', `Tool ${call.name} failed:`, error)
      return {
        success: false,
        output: `Tool execution error: ${message}`,
      }
    }
  }

  async executeAll(calls: ToolCall[], cwd: string): Promise<Map<string, ToolResult>> {
    const results = new Map<string, ToolResult>()

    const executions = calls.map(async (call) => {
      const result = await this.execute(call, cwd)
      return { id: call.id, result }
    })

    const resolved = await Promise.all(executions)

    for (const { id, result } of resolved) {
      results.set(id, result)
    }

    return results
  }

  listTools(): string[] {
    return Array.from(this.tools.keys())
  }
}

export function createToolExecutor(): ToolExecutor {
  return new ToolExecutor()
}
