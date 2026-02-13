import type { LLMProvider } from './types'
import type { RuntimeConfig } from '../config'
import { createLlamaCppProvider } from './llamacpp'
import { createAnthropicProvider } from './anthropic'
import { createOpenAIProvider } from './openai'

export * from './types'
export { createLlamaCppProvider, createLlamaCppTokenizer } from './llamacpp'
export { createAnthropicProvider } from './anthropic'
export { createOpenAIProvider } from './openai'

export interface ProviderRegistry {
  local: LLMProvider
  remote: LLMProvider | null
  getProvider(type: 'local' | 'remote'): LLMProvider | null
}

export function createProviderRegistry(config: RuntimeConfig): ProviderRegistry {
  // Create local provider (always llama.cpp)
  const local = createLlamaCppProvider(config.local.endpoint, config.local.model)

  // Create remote provider (prefer Anthropic, fallback to OpenAI)
  let remote: LLMProvider | null = null
  if (config.remote.anthropic) {
    remote = createAnthropicProvider(
      config.remote.anthropic.apiKey,
      config.remote.anthropic.model
    )
  } else if (config.remote.openai) {
    remote = createOpenAIProvider(
      config.remote.openai.apiKey,
      config.remote.openai.model
    )
  }

  return {
    local,
    remote,
    getProvider(type: 'local' | 'remote'): LLMProvider | null {
      return type === 'local' ? local : remote
    },
  }
}
