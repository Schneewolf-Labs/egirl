import type { RuntimeConfig } from '../config'
import { log } from '../util/logger'
import { createAnthropicProvider } from './anthropic'
import { KeyPool } from './key-pool'
import { createLlamaCppProvider } from './llamacpp'
import { createOpenAIProvider } from './openai'
import type { ChatRequest, ChatResponse, LLMProvider } from './types'

export { createAnthropicProvider } from './anthropic'
export { KeyPool } from './key-pool'
export { createLlamaCppProvider } from './llamacpp'
export { createLlamaCppTokenizer } from './llamacpp-tokenizer'
export { createOpenAIProvider } from './openai'
export { formatMessagesForQwen3 } from './qwen3-format'
export * from './types'

export interface ProviderRegistry {
  local: LLMProvider
  remote: LLMProvider | null
  getProvider(type: 'local' | 'remote'): LLMProvider | null
  /**
   * Resolve a model reference to a provider instance.
   *
   * Supported formats:
   *   "local"                        — local llama.cpp provider
   *   "anthropic"                    — Anthropic with default model from config
   *   "openai"                       — OpenAI with default model from config
   *   "anthropic/<model>"            — Anthropic with a specific model override
   *   "openai/<model>"               — OpenAI with a specific model override
   *
   * Returns null if the referenced provider isn't configured (missing API key).
   * Providers for specific model overrides are cached so repeated calls
   * with the same ref reuse the same instance.
   */
  resolveModelRef(ref: string): LLMProvider | null
}

/**
 * Wraps a provider factory with a KeyPool.
 * On each chat call, gets the current key from the pool, creates a fresh
 * provider instance (cheap — just stores config), and reports success/error
 * back to the pool for cooldown tracking.
 */
class PooledProvider implements LLMProvider {
  readonly name: string
  private pool: KeyPool
  private factory: (apiKey: string) => LLMProvider

  constructor(name: string, pool: KeyPool, factory: (apiKey: string) => LLMProvider) {
    this.name = name
    this.pool = pool
    this.factory = factory
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = this.pool.get()
    const provider = this.factory(apiKey)

    try {
      const response = await provider.chat(req)
      this.pool.reportSuccess()
      return response
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const kind = KeyPool.classifyError(msg)
      this.pool.reportError(kind)

      // If we have other keys available, retry once with the next key
      if (this.pool.availableCount() > 0 && (kind === 'rate_limit' || kind === 'auth')) {
        log.info('provider', `Retrying with next key after ${kind} error`)
        const nextKey = this.pool.get()
        const nextProvider = this.factory(nextKey)
        try {
          const response = await nextProvider.chat(req)
          this.pool.reportSuccess()
          return response
        } catch (retryError) {
          const retryMsg = retryError instanceof Error ? retryError.message : String(retryError)
          this.pool.reportError(KeyPool.classifyError(retryMsg))
          throw retryError
        }
      }

      throw error
    }
  }
}

export function createProviderRegistry(config: RuntimeConfig): ProviderRegistry {
  // Create local provider (always llama.cpp)
  const local = createLlamaCppProvider(config.local.endpoint, config.local.model)

  // Create remote provider (prefer Anthropic, fallback to OpenAI)
  let remote: LLMProvider | null = null
  if (config.remote.anthropic) {
    const { apiKeys, model } = config.remote.anthropic
    if (apiKeys.length > 1) {
      const pool = new KeyPool(apiKeys)
      remote = new PooledProvider(`anthropic/${model}`, pool, (key) =>
        createAnthropicProvider(key, model),
      )
      log.info('provider', `Anthropic provider with ${apiKeys.length} keys in pool`)
    } else {
      remote = createAnthropicProvider(apiKeys[0] ?? '', model)
    }
  } else if (config.remote.openai) {
    const { apiKeys, model, baseUrl } = config.remote.openai
    if (apiKeys.length > 1) {
      const pool = new KeyPool(apiKeys)
      remote = new PooledProvider(`openai/${model}`, pool, (key) =>
        createOpenAIProvider(key, model, baseUrl),
      )
      log.info('provider', `OpenAI provider with ${apiKeys.length} keys in pool`)
    } else {
      remote = createOpenAIProvider(apiKeys[0] ?? '', model, baseUrl)
    }
  }

  // Cache for model-specific provider overrides (e.g. "anthropic/claude-opus-4-20250514")
  const overrideCache = new Map<string, LLMProvider>()

  function resolveModelRef(ref: string): LLMProvider | null {
    if (ref === 'local') return local

    if (ref === 'anthropic') {
      if (!config.remote.anthropic) return null
      return remote?.name.startsWith('anthropic/') ? remote : null
    }

    if (ref === 'openai') {
      if (!config.remote.openai) return null
      // If remote is the OpenAI provider with the default model, return it
      if (remote?.name.startsWith('openai/')) return remote
      // Otherwise create one (Anthropic was preferred as remote, but OpenAI is also configured)
      const cached = overrideCache.get(ref)
      if (cached) return cached
      const provider = createOpenAIProvider(
        config.remote.openai.apiKey,
        config.remote.openai.model,
        config.remote.openai.baseUrl,
      )
      overrideCache.set(ref, provider)
      return provider
    }

    // Handle "provider/model" format
    const slashIndex = ref.indexOf('/')
    if (slashIndex === -1) return null

    const providerName = ref.substring(0, slashIndex)
    const modelName = ref.substring(slashIndex + 1)

    // Check cache first
    const cached = overrideCache.get(ref)
    if (cached) return cached

    if (providerName === 'anthropic' && config.remote.anthropic) {
      // If the requested model matches the default, return the existing provider
      if (modelName === config.remote.anthropic.model && remote?.name.startsWith('anthropic/')) {
        return remote
      }
      const provider = createAnthropicProvider(config.remote.anthropic.apiKey, modelName)
      overrideCache.set(ref, provider)
      return provider
    }

    if (providerName === 'openai' && config.remote.openai) {
      if (modelName === config.remote.openai.model && remote?.name.startsWith('openai/')) {
        return remote
      }
      const provider = createOpenAIProvider(
        config.remote.openai.apiKey,
        modelName,
        config.remote.openai.baseUrl,
      )
      overrideCache.set(ref, provider)
      return provider
    }

    return null
  }

  return {
    local,
    remote,
    getProvider(type: 'local' | 'remote'): LLMProvider | null {
      return type === 'local' ? local : remote
    },
    resolveModelRef,
  }
}
