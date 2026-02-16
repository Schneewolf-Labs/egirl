import { describe, expect, test } from 'bun:test'
import type { RuntimeConfig } from '../../src/config'
import type { ChatMessage } from '../../src/providers/types'
import { createRouter } from '../../src/routing'

describe('Router', () => {
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
      models: {},
    },
    channels: {},
    skills: { dirs: [] },
  }

  const configWithRemote: RuntimeConfig = {
    ...baseConfig,
    remote: {
      anthropic: {
        apiKey: 'test-key',
        model: 'claude-sonnet-4-20250514',
      },
    },
  }

  const router = createRouter(configWithRemote)
  const localOnlyRouter = createRouter(baseConfig)

  test('routes simple greetings to local', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }]

    const decision = router.route(messages)
    expect(decision.target).toBe('local')
  })

  test('routes code generation requests to remote', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Write code to implement a binary search tree' },
    ]

    const decision = router.route(messages)
    expect(decision.target).toBe('remote')
  })

  test('analyzes task complexity', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }]

    const analysis = router.analyzeTask(messages)
    expect(analysis.complexity).toBe('trivial')
  })

  test('falls back to local when no remote configured', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Write code to implement a binary search tree' },
    ]

    const decision = localOnlyRouter.route(messages)
    expect(decision.target).toBe('local')
    expect(decision.reason).toBe('no_remote_provider')
  })

  test('detects code discussion with code blocks', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'What does this code do?\n```js\nconst x = 1\n```' },
    ]

    const decision = router.route(messages)
    expect(decision.target).toBe('remote')
    expect(decision.reason).toContain('code')
  })

  test('routes memory operations to local', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'What do you remember about my project?' },
    ]

    const analysis = router.analyzeTask(messages)
    expect(analysis.type).toBe('memory_op')
  })

  test('skill-based routing overrides default for matched skills', () => {
    const skills = [
      {
        name: 'Code Review',
        description: 'Review code changes',
        content: '# Code Review\n\nInstructions...',
        metadata: { egirl: { complexity: 'remote' as const } },
        baseDir: '/tmp/skills/code-review',
        enabled: true,
      },
    ]

    const routerWithSkills = createRouter(configWithRemote, skills)

    const messages: ChatMessage[] = [{ role: 'user', content: 'Can you review this change?' }]

    const decision = routerWithSkills.route(messages)
    expect(decision.target).toBe('remote')
    expect(decision.reason).toBe('skill:Code Review')
  })

  test('handles ContentPart[] messages without crashing', () => {
    const skills = [
      {
        name: 'Code Review',
        description: 'Review code changes',
        content: '# Code Review',
        metadata: { egirl: { complexity: 'remote' as const } },
        baseDir: '/tmp/skills/code-review',
        enabled: true,
      },
    ]

    const routerWithSkills = createRouter(configWithRemote, skills)

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please review this code' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
        ],
      },
    ]

    // Should not throw — previously crashed because matchSkills received ContentPart[]
    const decision = routerWithSkills.route(messages)
    expect(decision.target).toBeDefined()
  })

  test('matches skills via escalation triggers', () => {
    const skills = [
      {
        name: 'Research',
        description: 'Research topics',
        content: '# Research',
        metadata: {
          egirl: {
            complexity: 'remote' as const,
            escalationTriggers: ['investigate', 'look up'],
          },
        },
        baseDir: '/tmp/skills/research',
        enabled: true,
      },
    ]

    const routerWithSkills = createRouter(configWithRemote, skills)

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Can you investigate how Bun handles ESM imports?' },
    ]

    const decision = routerWithSkills.route(messages)
    expect(decision.target).toBe('remote')
    expect(decision.reason).toBe('skill:Research')
  })

  test('includes model chain from routing.models for matching task type', () => {
    const configWithModels: RuntimeConfig = {
      ...configWithRemote,
      routing: {
        ...configWithRemote.routing,
        models: {
          code_generation: ['anthropic/claude-opus-4-20250514', 'openai/gpt-4o', 'local'],
        },
      },
    }

    const r = createRouter(configWithModels)
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Write code to implement a sorting algorithm' },
    ]

    const decision = r.route(messages)
    expect(decision.modelChain).toEqual([
      'anthropic/claude-opus-4-20250514',
      'openai/gpt-4o',
      'local',
    ])
    expect(decision.reason).toBe('models:code_generation')
    expect(decision.target).toBe('remote')
  })

  test('uses models.default chain when no task-specific chain matches', () => {
    const configWithDefault: RuntimeConfig = {
      ...configWithRemote,
      routing: {
        ...configWithRemote.routing,
        models: {
          default: ['local', 'anthropic'],
        },
      },
    }

    const r = createRouter(configWithDefault)
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello there' }]

    const decision = r.route(messages)
    expect(decision.modelChain).toEqual(['local', 'anthropic'])
    expect(decision.target).toBe('local')
    expect(decision.reason).toBe('models:conversation')
  })

  test('model chain with local first sets target to local', () => {
    const configWithModels: RuntimeConfig = {
      ...configWithRemote,
      routing: {
        ...configWithRemote.routing,
        models: {
          conversation: ['local', 'anthropic'],
        },
      },
    }

    const r = createRouter(configWithModels)
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }]

    const decision = r.route(messages)
    expect(decision.target).toBe('local')
    expect(decision.provider).toBe('local')
  })

  test('no model chain when routing.models is empty', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }]

    const decision = router.route(messages)
    expect(decision.modelChain).toBeUndefined()
  })

  test('falls back to local when model chain specifies remote but no provider configured', () => {
    const configNoRemoteWithModels: RuntimeConfig = {
      ...baseConfig,
      routing: {
        ...baseConfig.routing,
        models: {
          conversation: ['anthropic', 'local'],
        },
      },
    }

    const r = createRouter(configNoRemoteWithModels)
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }]

    const decision = r.route(messages)
    expect(decision.target).toBe('local')
    expect(decision.reason).toBe('models:fallback_to_local')
  })
})
