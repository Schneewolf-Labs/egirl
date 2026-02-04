export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
}

export interface ChatResponse {
  content: string
  toolCalls?: ToolCall[]
  usage: {
    inputTokens: number
    outputTokens: number
  }
  // egirl extensions
  confidence?: number  // 0-1, only from local with confidence estimation
  model: string
  provider: 'local' | 'remote'
}

export interface ChatStreamChunk {
  type: 'content' | 'tool_call' | 'done'
  content?: string
  toolCall?: Partial<ToolCall>
  usage?: {
    inputTokens: number
    outputTokens: number
  }
}

export interface LLMProvider {
  name: string
  type: 'local' | 'remote'
  chat(request: ChatRequest): Promise<ChatResponse>
  chatStream?(request: ChatRequest): AsyncIterable<ChatStreamChunk>
}
