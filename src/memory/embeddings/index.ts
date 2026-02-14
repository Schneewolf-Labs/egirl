export type { EmbeddingInput, EmbeddingProvider, EmbeddingProviderType, EmbeddingProviderConfig } from './types'
export { Qwen3VLEmbeddings } from './qwen3-vl'
export { LlamaCppEmbeddings } from './llamacpp'
export { OpenAIEmbeddings } from './openai'

import type { EmbeddingProvider, EmbeddingProviderType, EmbeddingProviderConfig } from './types'
import { Qwen3VLEmbeddings } from './qwen3-vl'
import { LlamaCppEmbeddings } from './llamacpp'
import { OpenAIEmbeddings } from './openai'

export function createEmbeddingProvider(
  type: EmbeddingProviderType,
  config: EmbeddingProviderConfig
): EmbeddingProvider {
  switch (type) {
    case 'qwen3-vl':
      return new Qwen3VLEmbeddings(
        config.endpoint ?? 'http://localhost:8082',
        config.dimensions ?? 2048
      )
    case 'llamacpp':
      return new LlamaCppEmbeddings(
        config.endpoint ?? 'http://localhost:8081',
        config.model ?? 'qwen3-vl-embedding',
        {
          dimensions: config.dimensions ?? 2048,
          multimodal: config.multimodal ?? false,
        }
      )
    case 'openai':
      if (!config.apiKey) throw new Error('OpenAI API key required')
      return new OpenAIEmbeddings(config.apiKey, config.model, config.dimensions, config.baseUrl)
    default:
      throw new Error(`Unknown embedding provider: ${type}`)
  }
}
