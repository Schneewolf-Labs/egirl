/**
 * Configurable recovery caps: the `[recovery]` config section overrides the retry budgets
 * the rules run with, and absent config keeps the incident-derived defaults.
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import { DEFAULT_RECOVERY_CAPS, resolveRecoveryCaps } from '../../src/agent/recovery'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

// Unrecoverable junk: no repairable name, so it genuinely strands (see recovery-nudges.test.ts).
const MANGLED = '<tool_call>\n{"nmae": ??? broken beyond repair}\n</tool_call>'

function makeAgent(
  provider: LLMProvider,
  sessionId: string,
  recovery?: RuntimeRecovery,
): AgentLoop {
  const config = makeConfig(makeWorkspace())
  if (recovery) config.recovery = recovery
  return new AgentLoop({
    config,
    toolExecutor: makeExecutorWithNoop(),
    localProvider: provider,
    sessionId,
  })
}

type RuntimeRecovery = NonNullable<ReturnType<typeof makeConfig>['recovery']>

describe('resolveRecoveryCaps', () => {
  test('returns the defaults when config has no recovery section', () => {
    expect(resolveRecoveryCaps()).toEqual(DEFAULT_RECOVERY_CAPS)
  })

  test('config values override the defaults field by field', () => {
    const caps = resolveRecoveryCaps({ nudgeRetries: 1 })
    expect(caps.nudgeRetries).toBe(1)
    expect(caps.continuationRetries).toBe(DEFAULT_RECOVERY_CAPS.continuationRetries)
    expect(caps.emptyRetries).toBe(DEFAULT_RECOVERY_CAPS.emptyRetries)
  })
})

describe('configured recovery caps drive the loop', () => {
  test('nudge_retries = 1 gives up after a single reissue nudge', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        return stubResponse({ content: MANGLED })
      },
    }
    const agent = makeAgent(provider, 'test:caps-nudge', {
      continuationRetries: 3,
      nudgeRetries: 1,
      emptyRetries: 2,
    })
    await agent.run('do the thing')
    // 1 original + 1 nudged retry (default budget would make this 4).
    expect(calls).toBe(2)
  })

  test('continuation_retries = 1 accepts the second truncated response as final', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        return stubResponse({
          content: calls === 1 ? 'part one ' : 'part two',
          finish_reason: 'length',
        })
      },
    }
    const agent = makeAgent(provider, 'test:caps-continuation', {
      continuationRetries: 1,
      nudgeRetries: 3,
      emptyRetries: 2,
    })
    const response = await agent.run('write something long')
    expect(calls).toBe(2)
    expect(response.content).toBe('part one part two')
    expect(response.continuationRetries).toBe(1)
  })

  test('empty_retries = 0 gives up on the first empty response', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        return stubResponse({ content: '' })
      },
    }
    const agent = makeAgent(provider, 'test:caps-empty', {
      continuationRetries: 3,
      nudgeRetries: 3,
      emptyRetries: 0,
    })
    const response = await agent.run('say something')
    expect(calls).toBe(1)
    expect(response.content).toBe('[The model returned an empty response.]')
  })
})
