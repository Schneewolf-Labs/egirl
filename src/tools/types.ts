import type { ToolDefinition } from '../providers/types'

export type { ToolDefinition } from '../providers/types'

export interface ToolResult {
  success: boolean
  output: string
  suggest_escalation?: boolean
  escalation_reason?: string
  isImage?: boolean // Output is a base64 data URL
  /**
   * The tool asked the supervisor for input and none arrived (report mode=ask timeout).
   * Surfaces through AgentResponse so a task runner can park the run as "awaiting input"
   * instead of scheduling the next one. See docs/autonomy-loop.md.
   */
  awaitingInput?: boolean
}

/**
 * Who is calling. Most tools do not care; one that must route a later answer back to the run
 * that asked (delegate) needs the session, and has no other way to learn it.
 */
export interface ToolCallContext {
  sessionId?: string
}

export interface Tool {
  definition: ToolDefinition
  execute(params: Record<string, unknown>, cwd: string, ctx?: ToolCallContext): Promise<ToolResult>
}
