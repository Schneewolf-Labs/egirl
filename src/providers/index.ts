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
  /**
   * Optional smaller model for side work — compaction summaries and memory extraction.
   *
   * Those run on every compaction and every few turns, and they neither need the operator model's
   * capability nor should they occupy its slot: a summary generated under context pressure is what
   * turned a sixteen-search research run into "fresh project scaffolded", and it was produced by
   * the same 27B that was mid-task. Undefined means "use the main provider", which is the previous
   * behaviour exactly.
   */
  auxiliary?: LLMProvider
}

export function createProviderRegistry(config: RuntimeConfig): ProviderRegistry {
  const local = createLlamaCppProvider(
    config.local.endpoint,
    config.local.model,
    config.local.staleStreamTimeoutMs,
    config.local.maxConcurrent,
    config.local.temperature,
  )

  const auxiliary = config.local.auxiliary
    ? createLlamaCppProvider(
        config.local.auxiliary.endpoint,
        config.local.auxiliary.model,
        config.local.staleStreamTimeoutMs,
        config.local.auxiliary.maxConcurrent ?? 1,
        // Summaries and extractions want determinism far more than variety.
        config.local.auxiliary.temperature ?? 0,
      )
    : undefined

  return auxiliary ? { local, auxiliary } : { local }
}
