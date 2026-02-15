import { describe, expect, test } from 'bun:test'
import type { RuntimeConfig } from '../../src/config'
import { createProviderRegistry } from '../../src/providers'

const baseConfig: RuntimeConfig = {
  workspace: { path: '/tmp/test' },
  local: {
    endpoint: 'http://localhost:8080',
    model: 'test-model',
    contextLength: 32768,
    maxConcurrent: 2,
  },
  remote: {},
  routing: {
    default: 'local',
    escalationThreshold: 0.4,
    alwaysLocal: [],
    alwaysRemote: [],
    models: {},
  },
  channels: {},
  skills: { dirs: [] },
}

describe('ProviderRegistry.resolveModelRef', () => {
  test('resolves "local" to the local provider', () => {
    const registry = createProviderRegistry(baseConfig)
    const provider = registry.resolveModelRef('local')
    expect(provider).toBeDefined()
    expect(provider?.name).toContain('llamacpp/')
  })

  test('returns null for "anthropic" when no API key configured', () => {
    const registry = createProviderRegistry(baseConfig)
    expect(registry.resolveModelRef('anthropic')).toBeNull()
  })

  test('returns null for "openai" when no API key configured', () => {
    const registry = createProviderRegistry(baseConfig)
    expect(registry.resolveModelRef('openai')).toBeNull()
  })

  test('resolves "anthropic" to the default Anthropic provider', () => {
    const config: RuntimeConfig = {
      ...baseConfig,
      remote: {
        anthropic: { apiKey: 'test-key', model: 'claude-sonnet-4-20250514' },
      },
    }
    const registry = createProviderRegistry(config)
    const provider = registry.resolveModelRef('anthropic')
    expect(provider).toBeDefined()
    expect(provider?.name).toBe('anthropic/claude-sonnet-4-20250514')
  })

  test('resolves "openai" when OpenAI is configured', () => {
    const config: RuntimeConfig = {
      ...baseConfig,
      remote: {
        openai: { apiKey: 'test-key', model: 'gpt-4o' },
      },
    }
    const registry = createProviderRegistry(config)
    const provider = registry.resolveModelRef('openai')
    expect(provider).toBeDefined()
    expect(provider?.name).toBe('openai/gpt-4o')
  })

  test('resolves "anthropic/specific-model" to a model-specific provider', () => {
    const config: RuntimeConfig = {
      ...baseConfig,
      remote: {
        anthropic: { apiKey: 'test-key', model: 'claude-sonnet-4-20250514' },
      },
    }
    const registry = createProviderRegistry(config)
    const provider = registry.resolveModelRef('anthropic/claude-opus-4-20250514')
    expect(provider).toBeDefined()
    expect(provider?.name).toBe('anthropic/claude-opus-4-20250514')
  })

  test('returns the default provider when specific model matches default', () => {
    const config: RuntimeConfig = {
      ...baseConfig,
      remote: {
        anthropic: { apiKey: 'test-key', model: 'claude-sonnet-4-20250514' },
      },
    }
    const registry = createProviderRegistry(config)
    const defaultProvider = registry.resolveModelRef('anthropic')
    const specificProvider = registry.resolveModelRef('anthropic/claude-sonnet-4-20250514')
    // Should be the same instance
    expect(defaultProvider).toBe(specificProvider)
  })

  test('caches model-specific providers', () => {
    const config: RuntimeConfig = {
      ...baseConfig,
      remote: {
        anthropic: { apiKey: 'test-key', model: 'claude-sonnet-4-20250514' },
      },
    }
    const registry = createProviderRegistry(config)
    const first = registry.resolveModelRef('anthropic/claude-opus-4-20250514')
    const second = registry.resolveModelRef('anthropic/claude-opus-4-20250514')
    expect(first).toBe(second)
  })

  test('returns null for unknown provider prefix', () => {
    const registry = createProviderRegistry(baseConfig)
    expect(registry.resolveModelRef('deepseek/v3')).toBeNull()
  })

  test('returns null for unknown bare name', () => {
    const registry = createProviderRegistry(baseConfig)
    expect(registry.resolveModelRef('deepseek')).toBeNull()
  })

  test('resolves "openai" when both anthropic and openai are configured', () => {
    const config: RuntimeConfig = {
      ...baseConfig,
      remote: {
        anthropic: { apiKey: 'test-key-a', model: 'claude-sonnet-4-20250514' },
        openai: { apiKey: 'test-key-o', model: 'gpt-4o' },
      },
    }
    const registry = createProviderRegistry(config)
    // When both are configured, "remote" defaults to Anthropic
    // But resolveModelRef("openai") should still return the OpenAI provider
    const provider = registry.resolveModelRef('openai')
    expect(provider).toBeDefined()
    expect(provider?.name).toBe('openai/gpt-4o')
  })
})
