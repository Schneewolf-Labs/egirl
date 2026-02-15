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
  parameters: Record<string, unknown> // JSON Schema
}

export interface ThinkingConfig {
  /** Thinking level: off disables, low/medium/high set increasing budget */
  level: 'off' | 'low' | 'medium' | 'high'
  /** Override budget_tokens directly (takes precedence over level mapping) */
  budgetTokens?: number
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  max_tokens?: number
  /** If provided, the provider streams tokens via this callback */
  onToken?: (token: string) => void
  /** Extended thinking / reasoning configuration */
  thinking?: ThinkingConfig
}

export interface ChatResponse {
  content: string
  tool_calls?: ToolCall[]
  usage: { input_tokens: number; output_tokens: number }
  confidence?: number // local model only, 0-1
  model: string
  /** Extended thinking / reasoning content from the model */
  thinking?: string
}

export interface LLMProvider {
  readonly name: string
  chat(req: ChatRequest): Promise<ChatResponse>
}

/**
 * Counts tokens for a string using the provider's actual tokenizer.
 * Implementations should cache results for repeated calls with the same input.
 */
export interface Tokenizer {
  countTokens(text: string): Promise<number>
}

/**
 * Extract text from string or ContentPart[] message content.
 */
export function getTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

/** Map thinking level to budget_tokens. Returns 0 for 'off'. */
export function thinkingBudget(config: ThinkingConfig): number {
  if (config.budgetTokens !== undefined) return config.budgetTokens
  switch (config.level) {
    case 'off':
      return 0
    case 'low':
      return 2048
    case 'medium':
      return 8192
    case 'high':
      return 32768
  }
}

/**
 * Thrown when the prompt exceeds the provider's context window.
 * Contains the actual token counts from the server for retry logic.
 */
export class ContextSizeError extends Error {
  readonly promptTokens: number
  readonly contextSize: number

  constructor(promptTokens: number, contextSize: number) {
    super(`Prompt (${promptTokens} tokens) exceeds context size (${contextSize} tokens)`)
    this.name = 'ContextSizeError'
    this.promptTokens = promptTokens
    this.contextSize = contextSize
  }
}
