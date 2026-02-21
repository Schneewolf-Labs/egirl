import type { EnergyBudget } from '../energy'
import type { ToolCall } from '../providers/types'
import type { SafetyConfig } from '../safety'
import { checkToolCall, getAuditLogPath, logToolExecution } from '../safety'
import { log } from '../util/logger'
import type { Tool, ToolDefinition, ToolResult } from './types'

export type ConfirmCallback = (toolName: string, args: Record<string, unknown>) => Promise<boolean>

/** Execution context: interactive calls bypass energy checks, autonomous calls are gated */
export type ExecutionContext = 'interactive' | 'autonomous'

export class ToolExecutor {
  private tools: Map<string, Tool> = new Map()
  private safety?: SafetyConfig
  private confirmCallback?: ConfirmCallback
  private energy?: EnergyBudget
  private executionContext: ExecutionContext = 'interactive'

  setSafety(config: SafetyConfig): void {
    this.safety = config
  }

  setEnergy(budget: EnergyBudget): void {
    this.energy = budget
  }

  setExecutionContext(context: ExecutionContext): void {
    this.executionContext = context
  }

  setConfirmCallback(callback: ConfirmCallback): void {
    this.confirmCallback = callback
  }

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
    return Array.from(this.tools.values()).map((t) => t.definition)
  }

  private auditLogPath(): string | undefined {
    return this.safety ? getAuditLogPath(this.safety) : undefined
  }

  private audit(
    toolName: string,
    args: Record<string, unknown>,
    result: { success: boolean; blocked?: boolean; reason?: string },
  ): void {
    const logPath = this.auditLogPath()
    if (logPath) {
      logToolExecution(toolName, args, result, logPath)
    }
  }

  async execute(call: ToolCall, cwd: string): Promise<ToolResult> {
    const tool = this.tools.get(call.name)

    if (!tool) {
      return {
        success: false,
        output: `Unknown tool: ${call.name}`,
      }
    }

    // Safety checks
    if (this.safety?.enabled) {
      const check = checkToolCall(call.name, call.arguments, cwd, this.safety)

      if (!check.allowed) {
        if (check.needsConfirmation) {
          if (this.confirmCallback) {
            const confirmed = await this.confirmCallback(call.name, call.arguments)
            if (!confirmed) {
              this.audit(call.name, call.arguments, {
                success: false,
                blocked: true,
                reason: 'User denied confirmation',
              })
              return { success: false, output: 'Tool execution denied by user.' }
            }
            // Confirmed — fall through to execute
          } else {
            // No confirmation callback wired up — allow with warning rather than
            // silently blocking. The user enabled confirmation mode but no channel
            // supports it yet, so fail-open is safer than breaking all tool calls.
            log.warn(
              'safety',
              `Tool ${call.name} needs confirmation but no callback is registered — allowing`,
            )
          }
        } else {
          this.audit(call.name, call.arguments, {
            success: false,
            blocked: true,
            reason: check.reason,
          })
          log.warn('safety', `Blocked tool call: ${call.name}`, { reason: check.reason })
          return { success: false, output: `Safety check failed: ${check.reason}` }
        }
      }
    }

    // Energy check (only for autonomous context — interactive calls bypass)
    if (this.energy && this.executionContext === 'autonomous') {
      const spend = this.energy.spend(call.name, `tool:${call.name}`)
      if (!spend.allowed) {
        this.audit(call.name, call.arguments, {
          success: false,
          blocked: true,
          reason: spend.reason,
        })
        log.info('energy', `Blocked ${call.name}: ${spend.reason}`)
        return {
          success: false,
          output: `Energy budget exceeded: ${call.name} costs ${spend.cost} energy, current balance is ${spend.remaining.toFixed(1)}. Wait for energy to regenerate.`,
        }
      }
    }

    log.debug('tools', `Executing tool: ${call.name}`, call.arguments)

    try {
      const result = await tool.execute(call.arguments, cwd)
      log.debug('tools', `Tool ${call.name} completed:`, {
        success: result.success,
        outputLength: result.output.length,
      })

      this.audit(call.name, call.arguments, { success: result.success })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('tools', `Tool ${call.name} failed:`, error)

      this.audit(call.name, call.arguments, { success: false, reason: message })
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
