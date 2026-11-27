import type { RuntimeConfig } from '../config'
import { createClaudeProvider } from './claude'
import { createAuxFallbackProvider } from './fallback'
import { createLlamaCppProvider } from './llamacpp'
import type { LLMProvider } from './types'
import { createWitchgridPromoter, createWitchgridReresolver } from './witchgrid'

export { type ApiMessage, toApiMessages } from './chat-format'
export { createLlamaCppProvider } from './llamacpp'
export { createLlamaCppTokenizer } from './llamacpp-tokenizer'
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
  if (config.local.isClaude) return { local: createClaudeProvider(config.local.model) }
  const local = createLlamaCppProvider(
    config.local.endpoint,
    config.local.model,
    config.local.staleStreamTimeoutMs,
    config.local.maxConcurrent,
    config.local.temperature,
    config.local.apiKey,
    config.local.witchgrid
      ? createWitchgridReresolver(config.local.witchgrid, config.local)
      : undefined,
    config.local.witchgrid
      ? createWitchgridPromoter(config.local.witchgrid, config.local)
      : undefined,
    config.local.isHosted,
  )

  const aux = config.local.auxiliary
  if (!aux) return { local }

  const auxiliary = createLlamaCppProvider(
    aux.endpoint,
    aux.model,
    config.local.staleStreamTimeoutMs,
    aux.maxConcurrent ?? 1,
    // Summaries and extractions want determinism far more than variety.
    aux.temperature ?? 0,
  )
  // A configured auxiliary that is down must not take side work down with it.
  return {
    local,
    auxiliary: createAuxFallbackProvider({ auxiliary, operator: local, endpoint: aux.endpoint }),
  }
}
