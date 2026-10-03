import { describe, expect, test } from 'bun:test'
import { getCodeAgentConfig } from '../src/bootstrap'
import type { RuntimeConfig } from '../src/config/schema'

describe('getCodeAgentConfig', () => {
  test('passes the failover chain and the timeout through to the tool', () => {
    const config = {
      channels: {
        codeAgent: {
          provider: 'claude',
          providers: ['claude', 'codex'],
          permissionMode: 'default',
          workingDir: '/work',
          timeoutMs: 1_800_000,
        },
      },
    } as unknown as RuntimeConfig
    const cc = getCodeAgentConfig(config)
    expect(cc?.providers).toEqual(['claude', 'codex'])
    expect(cc?.timeoutMs).toBe(1_800_000)
  })
})
