import { describe, expect, test } from 'bun:test'
import type { RuntimeConfig } from '../../src/config'
import { applyRules, createRoutingRules, type RuleContext } from '../../src/routing/rules'

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
    alwaysLocal: ['memory_search', 'memory_get'],
    alwaysRemote: ['code_generation', 'code_review'],
  },
  channels: {},
  skills: { dirs: [] },
}

describe('createRoutingRules', () => {
  test('creates rules sorted by priority descending', () => {
    const rules = createRoutingRules(baseConfig)
    for (let i = 0; i < rules.length - 1; i++) {
      expect(rules[i].priority).toBeGreaterThanOrEqual(rules[i + 1].priority)
    }
  })

  test('includes always-local rules', () => {
    const rules = createRoutingRules(baseConfig)
    const localRules = rules.filter((r) => r.name.startsWith('always_local_'))
    expect(localRules).toHaveLength(2)
    expect(localRules.map((r) => r.name)).toContain('always_local_memory_search')
    expect(localRules.map((r) => r.name)).toContain('always_local_memory_get')
  })

  test('includes always-remote rules', () => {
    const rules = createRoutingRules(baseConfig)
    const remoteRules = rules.filter((r) => r.name.startsWith('always_remote_'))
    expect(remoteRules).toHaveLength(2)
    expect(remoteRules.map((r) => r.name)).toContain('always_remote_code_generation')
    expect(remoteRules.map((r) => r.name)).toContain('always_remote_code_review')
  })

  test('includes complexity-based rules', () => {
    const rules = createRoutingRules(baseConfig)
    const names = rules.map((r) => r.name)
    expect(names).toContain('trivial_local')
    expect(names).toContain('complex_remote')
  })

  test('includes large context rule', () => {
    const rules = createRoutingRules(baseConfig)
    const names = rules.map((r) => r.name)
    expect(names).toContain('large_context_remote')
  })

  test('includes default fallback rule', () => {
    const rules = createRoutingRules(baseConfig)
    const defaultRule = rules.find((r) => r.name === 'default')
    expect(defaultRule).toBeDefined()
    expect(defaultRule?.priority).toBe(0)
    expect(defaultRule?.target).toBe('local')
  })
})

describe('applyRules', () => {
  const rules = createRoutingRules(baseConfig)

  test('matches always-local for memory_search tool', () => {
    const context: RuleContext = {
      toolsInvolved: ['memory_search'],
      userContent: 'search my memories',
    }
    const result = applyRules(rules, context)
    expect(result.target).toBe('local')
    expect(result.rule).toBe('always_local_memory_search')
  })

  test('matches always-remote for code_generation task type', () => {
    const context: RuleContext = {
      taskType: 'code_generation',
      userContent: 'write a function',
    }
    const result = applyRules(rules, context)
    expect(result.target).toBe('remote')
    expect(result.rule).toBe('always_remote_code_generation')
  })

  test('routes trivial complexity to local', () => {
    const context: RuleContext = {
      complexity: 'trivial',
      userContent: 'hi',
    }
    const result = applyRules(rules, context)
    expect(result.target).toBe('local')
    expect(result.rule).toBe('trivial_local')
  })

  test('routes complex tasks to remote', () => {
    const context: RuleContext = {
      complexity: 'complex',
      userContent: 'a very long and complex request',
    }
    const result = applyRules(rules, context)
    expect(result.target).toBe('remote')
    expect(result.rule).toBe('complex_remote')
  })

  test('routes large context to remote', () => {
    const context: RuleContext = {
      estimatedTokens: 30000, // > 32768 * 0.8 = 26214
      userContent: 'something big',
    }
    const result = applyRules(rules, context)
    expect(result.target).toBe('remote')
    expect(result.rule).toBe('large_context_remote')
  })

  test('falls back to default for unmatched context', () => {
    const context: RuleContext = {
      complexity: 'simple',
      userContent: 'something ordinary',
    }
    const result = applyRules(rules, context)
    expect(result.target).toBe('local')
    expect(result.rule).toBe('default')
  })

  test('returns fallback when no rules match', () => {
    const result = applyRules([], { userContent: 'anything' })
    expect(result.target).toBe('local')
    expect(result.rule).toBe('fallback')
  })

  test('respects routing default of remote', () => {
    const remoteDefaultConfig: RuntimeConfig = {
      ...baseConfig,
      routing: { ...baseConfig.routing, default: 'remote' },
    }
    const remoteRules = createRoutingRules(remoteDefaultConfig)
    const defaultRule = remoteRules.find((r) => r.name === 'default')
    expect(defaultRule?.target).toBe('remote')
  })
})
