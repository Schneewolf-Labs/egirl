import type { LLMProvider } from './types'
import type { EgirlConfig } from '../config'
import { createLocalProvider, type LocalProviderType } from './local'
import { createRemoteProvider, type RemoteProviderType } from './remote'

export * from './types'
export { createLocalProvider, type LocalProviderType } from './local'
export { createRemoteProvider, type RemoteProviderType } from './remote'

export interface ProviderRegistry {
  local: LLMProvider | null
  remote: LLMProvider | null
  getProvider(type: 'local' | 'remote'): LLMProvider | null
}

export function createProviderRegistry(config: EgirlConfig): ProviderRegistry {
  // Create local provider
  const local = createLocalProvider(
    config.local.provider as LocalProviderType,
    config.local.endpoint,
    config.local.model
  )

  // Create remote provider (prefer Anthropic, fallback to OpenAI)
  let remote: LLMProvider | null = null
  if (config.remote.anthropic) {
    remote = createRemoteProvider(
      'anthropic',
      config.remote.anthropic.apiKey,
      config.remote.anthropic.defaultModel
    )
  } else if (config.remote.openai) {
    remote = createRemoteProvider(
      'openai',
      config.remote.openai.apiKey,
      config.remote.openai.defaultModel
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
