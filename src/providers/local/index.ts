import type { LLMProvider } from '../types'
import { createOllamaProvider } from './ollama'
import { createLlamaCppProvider } from './llamacpp'
import { createVLLMProvider } from './vllm'

export type LocalProviderType = 'ollama' | 'llamacpp' | 'vllm'

export function createLocalProvider(
  type: LocalProviderType,
  endpoint: string,
  model: string
): LLMProvider {
  switch (type) {
    case 'ollama':
      return createOllamaProvider(endpoint, model)
    case 'llamacpp':
      return createLlamaCppProvider(endpoint, model)
    case 'vllm':
      return createVLLMProvider(endpoint, model)
    default:
      throw new Error(`Unknown local provider type: ${type}`)
  }
}

export { createOllamaProvider } from './ollama'
export { createLlamaCppProvider } from './llamacpp'
export { createVLLMProvider } from './vllm'
