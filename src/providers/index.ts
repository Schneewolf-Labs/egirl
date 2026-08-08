import type { RuntimeConfig } from '../config'
import { createLlamaCppProvider } from './llamacpp'
import type { LLMProvider } from './types'

export { createLlamaCppProvider } from './llamacpp'
export { createLlamaCppTokenizer } from './llamacpp-tokenizer'
export { formatMessagesForQwen3 } from './qwen3-format'
export {
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ContentPart,
  ContextSizeError,
  getTextContent,
  type ImageContent,
  type LLMProvider,
  type TextContent,
  type ThinkingConfig,
  type Tokenizer,
  type ToolCall,
  type ToolDefinition,
  thinkingBudget,
} from './types'

export interface ProviderRegistry {
  local: LLMProvider
}

export function createProviderRegistry(config: RuntimeConfig): ProviderRegistry {
  const local = createLlamaCppProvider(
    config.local.endpoint,
    config.local.model,
    config.local.staleStreamTimeoutMs,
    config.local.maxConcurrent,
    config.local.temperature,
  )

  return { local }
}
