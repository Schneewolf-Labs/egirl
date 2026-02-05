import { describe, test, expect } from 'bun:test'
import { createRouter } from '../../src/routing'
import type { ChatMessage } from '../../src/providers/types'
import type { RuntimeConfig } from '../../src/config'

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
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
    ]

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
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hi' },
    ]

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
})
