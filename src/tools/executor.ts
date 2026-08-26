import type { EnergyBudget } from '../energy'
import type { ToolCall } from '../providers/types'
import type { SafetyConfig } from '../safety'
import { checkToolCall, getAuditLogPath, logToolExecution, scanForInjection } from '../safety'
import { log } from '../util/logger'
import { matchToolName, remapParamKeys } from './fuzzy-match'
import type { Tool, ToolDefinition, ToolResult } from './types'

export type ConfirmCallback = (toolName: string, args: Record<string, unknown>) => Promise<boolean>

/** Execution context: interactive calls bypass energy checks, autonomous calls are gated */
export type ExecutionContext = 'interactive' | 'autonomous'

/**
 * Tools whose output may contain untrusted external content
 * and should be scanned for prompt injection patterns.
 */
const SCANNABLE_TOOLS = new Set([
  'web_research',
  'browser_navigate',
  'browser_snapshot',
  'browser_eval',
  'execute_command',
  'read_file',
  'code_agent',
])

/**
 * Tools that mutate shared state and therefore must not race each other within one turn.
 * A model that emits two execute_command calls in one reply means them in order — `cd`
 * effects, file writes, and probe scripts all assume it. Reads and lookups stay concurrent.
 * (Hermes runs its interactive tools sequentially for the same reason.)
 */
const SEQUENTIAL_TOOLS = new Set([
  'execute_command',
  'write_file',
  'edit_file',
  'git_commit',
  'code_agent',
  'process_start',
  'process_send_input',
  'process_stop',
])

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

  /** Resolve a called name to a registered tool name (exact, then fuzzy) */
  private resolveName(name: string): string | undefined {
    if (this.tools.has(name)) return name
    return matchToolName(name, this.listTools()).match
  }

  async execute(call: ToolCall, cwd: string): Promise<ToolResult> {
    // Resolve near-miss names before safety/energy checks so they all see
    // the tool that actually runs, not the name the model emitted.
    if (!this.tools.has(call.name)) {
      const { match, suggestions } = matchToolName(call.name, this.listTools())
      if (!match) {
        const hint = suggestions.length > 0 ? `. Did you mean: ${suggestions.join(', ')}?` : ''
        return {
          success: false,
          output: `Unknown tool: ${call.name}${hint}`,
        }
      }
      log.info('tools', `Fuzzy-matched tool call "${call.name}" -> "${match}"`)
      call = { ...call, name: match }
    }

    const tool = this.tools.get(call.name)

    if (!tool) {
      return {
        success: false,
        output: `Unknown tool: ${call.name}`,
      }
    }

    // Same reason as the name resolution above: remap before the safety and energy checks,
    // so they inspect the arguments the tool will actually receive. Remapping afterwards
    // would let a renamed argument slip past safety entirely.
    {
      const { args, remapped } = remapParamKeys(call.arguments, tool.definition.parameters)
      if (remapped.length > 0) {
        log.info(
          'tools',
          `Remapped params for ${call.name}: ${remapped.map((r) => `${r.from} -> ${r.to}`).join(', ')}`,
        )
        call = { ...call, arguments: args }
      }
    }

    // Required-parameter check, after remapping so synonyms have already been resolved.
    // A call missing its required arguments used to reach the tool and die on whatever the
    // implementation threw — execute_command spawned undefined and returned a TypeError about
    // a "file" argument, which taught the model nothing. Observed from a q8 27B under long
    // context: most such calls arrive with an entirely empty arguments object, get the opaque
    // error back, and are re-issued malformed again. Name what is missing and show the shape.
    {
      const params = tool.definition.parameters as {
        required?: string[]
        properties?: Record<string, unknown>
      }
      const required = Array.isArray(params?.required) ? params.required : []
      const missing = required.filter(
        (key) => call.arguments[key] === undefined || call.arguments[key] === null,
      )
      if (missing.length > 0) {
        const example = JSON.stringify(Object.fromEntries(required.map((key) => [key, `<${key}>`])))
        this.audit(call.name, call.arguments, {
          success: false,
          reason: `missing required: ${missing.join(', ')}`,
        })
        return {
          success: false,
          output:
            `Missing required parameter${missing.length > 1 ? 's' : ''} for ${call.name}: ${missing.join(', ')}. ` +
            `Re-issue the call with arguments filled in, e.g. {"name": "${call.name}", "arguments": ${example}}`,
        }
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

      // Scan tool output for prompt injection if it handles external content
      if (this.safety?.enabled && SCANNABLE_TOOLS.has(call.name) && result.output) {
        const scan = scanForInjection(result.output)
        if (scan.detected) {
          log.warn(
            'safety',
            `Injection patterns detected in ${call.name} output: ${scan.matchedPatterns.join(', ')}`,
          )
          result.output = `[Warning: ${scan.matchCount} prompt injection pattern(s) detected and filtered in tool output]\n${scan.sanitized}`
        }
      }

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

    // Pre-check energy budget for the entire batch to avoid partial completion.
    // Without this, parallel tools race to spend energy and some succeed while
    // others fail — leaving the batch in an inconsistent half-done state.
    if (this.energy && this.executionContext === 'autonomous' && calls.length > 1) {
      const toolNames = calls.map((c) => this.resolveName(c.name) ?? c.name)
      const batch = this.energy.checkBatch(toolNames)
      if (!batch.allowed) {
        log.info(
          'energy',
          `Blocked batch of ${calls.length} tools: total cost ${batch.totalCost}, balance ${batch.current.toFixed(1)}`,
        )
        for (const call of calls) {
          this.audit(call.name, call.arguments, {
            success: false,
            blocked: true,
            reason: 'Batch energy budget exceeded',
          })
          results.set(call.id, {
            success: false,
            output: `Energy budget exceeded for batch: ${calls.length} tools cost ${batch.totalCost} total energy, current balance is ${batch.current.toFixed(1)}. Wait for energy to regenerate.`,
          })
        }
        return results
      }
    }

    // Mutating tools run strictly in emission order; everything else runs concurrently
    // alongside them. Two execute_command calls in one turn racing each other corrupts the
    // very state (cwd, files, probe output) the second call assumes the first prepared.
    const sequential = calls.filter((c) => SEQUENTIAL_TOOLS.has(this.resolveName(c.name) ?? c.name))
    const parallel = calls.filter((c) => !SEQUENTIAL_TOOLS.has(this.resolveName(c.name) ?? c.name))

    const parallelDone = Promise.all(
      parallel.map(async (call) => {
        const result = await this.execute(call, cwd)
        return { id: call.id, result }
      }),
    )

    for (const call of sequential) {
      results.set(call.id, await this.execute(call, cwd))
    }

    for (const { id, result } of await parallelDone) {
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
