export type TextContent = { type: 'text'; text: string }
export type ImageContent = { type: 'image_url'; image_url: { url: string } }
export type ContentPart = TextContent | ImageContent

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  max_tokens?: number
  /** If provided, the provider streams tokens via this callback */
  onToken?: (token: string) => void
}

export interface ChatResponse {
  content: string
  tool_calls?: ToolCall[]
  usage: { input_tokens: number; output_tokens: number }
  confidence?: number  // local model only, 0-1
  model: string
}

export interface LLMProvider {
  readonly name: string
  chat(req: ChatRequest): Promise<ChatResponse>
}
