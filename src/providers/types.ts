export type TextContent = { type: 'text'; text: string }
export type ImageContent = { type: 'image_url'; image_url: { url: string } }
export type ContentPart = TextContent | ImageContent

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_call_id?: string
  tool_calls?: ToolCall[]
  /**
   * Recovery scaffolding, not conversation. A mangled tool call and the nudge asking for its
   * reissue exist only to drive an in-run retry; persisting them would replay the model's own
   * failure into every future session's context. Skipped by history persistence.
   */
  ephemeral?: boolean
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
  /**
   * If provided, the provider streams reasoning tokens via this callback as they arrive.
   * A server that splits reasoning into its own field emits nothing on `onToken` until the
   * model stops deliberating, which on a hard question is minutes of apparent silence.
   */
  onThinkingToken?: (token: string) => void
  /** Extended thinking / reasoning configuration */
  thinking?: ThinkingConfig
  /** Abort signal — cancels the in-flight HTTP request / generation */
  signal?: AbortSignal
  /** Stable/volatile split for system prompt caching (Anthropic prefix caching) */
  systemPromptParts?: {
    stable: string
    volatile: string
  }
  /**
   * KV cache slot for local servers that keep per-slot prefix caches (sabrewing).
   * An agent re-sends its whole transcript every turn, so pinning a conversation to a
   * slot lets the server reuse the prefix it already prefilled instead of recomputing
   * it — measured 92x faster time-to-first-token on continuation turns. Sessions must
   * map to slots stably, or two conversations will evict each other.
   */
  cacheSlot?: number
}

export interface ChatResponse {
  content: string
  tool_calls?: ToolCall[]
  usage: { input_tokens: number; output_tokens: number }
  confidence?: number // local model only, 0-1
  model: string
  /** Extended thinking / reasoning content from the model */
  thinking?: string
  /** Why generation stopped: 'stop' (natural), 'length' (truncated), 'tool_calls', etc. */
  finish_reason?: 'stop' | 'length' | 'tool_calls' | string
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
