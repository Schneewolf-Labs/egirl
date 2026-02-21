import type { ToolDefinition } from '../providers/types'

export type { ToolDefinition } from '../providers/types'

export interface ToolResult {
  success: boolean
  output: string
  suggest_escalation?: boolean
  escalation_reason?: string
  isImage?: boolean // Output is a base64 data URL
}

export interface Tool {
  definition: ToolDefinition
  execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult>
}
