export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
}

export interface ToolResult {
  success: boolean
  output: string
  suggest_escalation?: boolean
  escalation_reason?: string
}

export interface Tool {
  definition: ToolDefinition
  execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult>
}
