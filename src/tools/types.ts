export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, {
      type: string
      description: string
      enum?: string[]
      items?: object
      default?: unknown
    }>
    required?: string[]
  }
}

export interface ToolContext {
  workspaceDir: string
  sessionId: string
  currentModel: 'local' | 'remote'
}

export interface ToolResult {
  success: boolean
  output: string
  // egirl extensions
  suggestEscalation?: boolean
  escalationReason?: string
}

export interface Tool {
  definition: ToolDefinition
  execute(params: unknown, context: ToolContext): Promise<ToolResult>
}
