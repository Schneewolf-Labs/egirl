import { describe, test, expect } from 'bun:test'
import { createModelRouter } from '../../src/routing'
import { defaultConfig } from '../../src/config/defaults'
import type { ChatMessage } from '../../src/providers/types'
import type { EgirlConfig } from '../../src/config'

describe('ModelRouter', () => {
  // Create config with mock remote provider for routing tests
  const configWithRemote: EgirlConfig = {
    ...defaultConfig,
    remote: {
      anthropic: {
        apiKey: 'test-key',
        defaultModel: 'claude-sonnet-4-20250514',
      },
    },
  }

  const router = createModelRouter(configWithRemote)
  const localOnlyRouter = createModelRouter(defaultConfig)

  test('routes simple greetings to local', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
    ]

    const decision = router.route(messages)
    expect(decision.model).toBe('local')
  })

  test('routes code generation requests to remote', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Write code to implement a binary search tree' },
    ]

    const decision = router.route(messages)
    expect(decision.model).toBe('remote')
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
    expect(decision.model).toBe('local')
    expect(decision.reason).toBe('no_remote_provider')
  })

  test('detects code discussion with code blocks', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'What does this code do?\n```js\nconst x = 1\n```' },
    ]

    const decision = router.route(messages)
    expect(decision.model).toBe('remote')
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
