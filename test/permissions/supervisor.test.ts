import { describe, expect, test } from 'bun:test'
import {
  createPermissionSupervisor,
  type PermissionSupervisorConfig,
} from '../../src/permissions/supervisor'
import type { LLMProvider } from '../../src/providers/types'

function config(overrides: Partial<PermissionSupervisorConfig> = {}): PermissionSupervisorConfig {
  return {
    mode: 'supervised',
    defaultAction: 'allow',
    thinkBeforeDeciding: true,
    minConfidence: 0.65,
    askUserBelowConfidence: false,
    memoryRecall: false,
    memoryWrite: false,
    ...overrides,
    policy: {
      allow: overrides.policy?.allow ?? [],
      deny: overrides.policy?.deny ?? [],
      askUser: overrides.policy?.askUser ?? [],
    },
  }
}

function provider(content: string): LLMProvider {
  return {
    name: 'fake',
    async chat() {
      return {
        content,
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'fake',
      }
    },
  }
}

const request = {
  backend: 'codex' as const,
  kind: 'permission' as const,
  originalTask: 'Fix tests',
  workingDir: '/repo',
  promptText: 'Allow command?\n1. Yes\n2. No',
  options: [
    { id: '1', label: 'Yes, allow' },
    { id: '2', label: 'No, deny' },
  ],
}

describe('PermissionSupervisor', () => {
  test('denies matching policy before model decision', async () => {
    const supervisor = createPermissionSupervisor({
      config: config({ policy: { deny: ['Allow command'], allow: [], askUser: [] } }),
      localProvider: provider('{"action":"choose","optionId":"1","reason":"ok","confidence":1}'),
    })

    const decision = await supervisor.decide(request)

    expect(decision.action).toBe('deny')
    expect(decision.reason).toContain('policy.deny')
  })

  test('converts allow policy to a matching choice option', async () => {
    const supervisor = createPermissionSupervisor({
      config: config({ policy: { allow: ['Allow command'], deny: [], askUser: [] } }),
    })

    const decision = await supervisor.decide(request)

    expect(decision.action).toBe('choose')
    expect(decision.optionId).toBe('1')
  })

  test('uses model JSON decision', async () => {
    const supervisor = createPermissionSupervisor({
      config: config(),
      localProvider: provider(
        '{"action":"choose","optionId":"2","reason":"risky","confidence":0.9}',
      ),
    })

    const decision = await supervisor.decide(request)

    expect(decision.action).toBe('choose')
    expect(decision.optionId).toBe('2')
    expect(decision.reason).toBe('risky')
  })

  test('escalates low-confidence decisions when configured', async () => {
    const supervisor = createPermissionSupervisor({
      config: config({ askUserBelowConfidence: true, minConfidence: 0.8 }),
      localProvider: provider(
        '{"action":"choose","optionId":"1","reason":"maybe","confidence":0.4}',
      ),
    })

    const decision = await supervisor.decide(request)

    expect(decision.action).toBe('ask_user')
    expect(decision.reason).toContain('below threshold')
  })

  test('recalls and writes memory when enabled', async () => {
    const calls: string[] = []
    const memory = {
      async searchHybrid(query: string) {
        calls.push(`search:${query}`)
        return [
          {
            memory: { key: 'pref', value: 'User allows bun test' },
            score: 1,
            matchType: 'hybrid',
          },
        ]
      },
      async set(key: string, value: string) {
        calls.push(`set:${key}:${value}`)
      },
    }
    const supervisor = createPermissionSupervisor({
      config: config({ memoryRecall: true, memoryWrite: true }),
      localProvider: provider(
        '{"action":"choose","optionId":"1","reason":"needed","confidence":0.9}',
      ),
      memory: memory as never,
    })

    await supervisor.decide(request)

    expect(calls.some((call) => call.startsWith('search:'))).toBe(true)
    expect(calls.some((call) => call.startsWith('set:permission:codex'))).toBe(true)
  })
})
