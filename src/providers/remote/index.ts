import type { LLMProvider } from '../types'
import { createAnthropicProvider } from './anthropic'
import { createOpenAIProvider } from './openai'

export type RemoteProviderType = 'anthropic' | 'openai'

export function createRemoteProvider(
  type: RemoteProviderType,
  apiKey: string,
  model: string
): LLMProvider {
  switch (type) {
    case 'anthropic':
      return createAnthropicProvider(apiKey, model)
    case 'openai':
      return createOpenAIProvider(apiKey, model)
    default:
      throw new Error(`Unknown remote provider type: ${type}`)
  }
}

export { createAnthropicProvider } from './anthropic'
export { createOpenAIProvider } from './openai'
