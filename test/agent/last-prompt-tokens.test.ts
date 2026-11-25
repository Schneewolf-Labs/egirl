/**
 * The context readout is what the model last saw.
 *
 * Stored history keeps stale tool output that is cleared only from the copy sent to the model,
 * so a history estimate read 139% while the provider reported 91% for the same window. The loop
 * keeps the provider's figure past the end of the run, and drops it once the window is cut.
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

function agentWith(inputTokens: number, id: string): AgentLoop {
  const provider: LLMProvider = {
    name: 'stub',
    async chat(): Promise<ChatResponse> {
      return stubResponse({
        content: 'done',
        usage: { input_tokens: inputTokens, output_tokens: 3 },
      })
    },
  }
  return new AgentLoop({
    config: makeConfig(makeWorkspace()),
    toolExecutor: makeExecutorWithNoop(),
    localProvider: provider,
    sessionId: id,
  })
}

describe('last prompt tokens', () => {
  test('a finished run leaves its measured prompt on the context status', async () => {
    const agent = agentWith(1234, 'test:last-prompt')
    expect((await agent.contextStatus()).lastPromptTokens).toBeUndefined()
    await agent.run('hi')
    expect((await agent.contextStatus()).lastPromptTokens).toBe(1234)
  })

  test('a provider that reports no usage leaves the estimate in charge', async () => {
    const agent = agentWith(0, 'test:last-prompt-zero')
    await agent.run('hi')
    expect((await agent.contextStatus()).lastPromptTokens).toBeUndefined()
  })

  test('compacting or clearing the window forgets the old measurement', async () => {
    const agent = agentWith(1234, 'test:last-prompt-cut')
    for (const msg of ['one', 'two', 'three']) await agent.run(msg)
    await agent.compactNow()
    expect((await agent.contextStatus()).lastPromptTokens).toBeUndefined()

    await agent.run('four')
    agent.clearContext()
    expect((await agent.contextStatus()).lastPromptTokens).toBeUndefined()
  })
})
