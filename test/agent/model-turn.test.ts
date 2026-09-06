import { describe, expect, test } from 'bun:test'
import type { ModelTurn } from '../../src/agent/events'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

/**
 * onModelTurn is the capture point for training data: it must carry the message array the
 * provider was actually handed (fitted, hoisted), not the live context, and it must fire for
 * every round trip including the forced final inference after max turns.
 */
describe('onModelTurn', () => {
  test('reports exactly what the provider received, once per round trip', async () => {
    const received: ChatMessage[][] = []
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        received.push(req.messages)
        calls++
        if (calls === 1) {
          return stubResponse({
            tool_calls: [{ id: 'call_1', name: 'noop', arguments: { n: 1 } }],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'done' })
      },
    }

    const turns: ModelTurn[] = []
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:model-turn',
    })

    await agent.run('do the thing', { events: { onModelTurn: (t) => turns.push(t) } })

    expect(turns).toHaveLength(2)
    expect(turns[0]!.messages).toBe(received[0]!)
    expect(turns[1]!.messages).toBe(received[1]!)
    // The array is the fitted one: system prompt at index 0, then the history.
    expect(turns[0]!.messages[0]!.role).toBe('system')
    expect(turns[0]!.messages.at(-1)!.content).toBe('do the thing')
    expect(turns[0]!.tools.map((t) => t.name)).toContain('noop')
    expect(turns[0]!.response.tool_calls?.[0]?.name).toBe('noop')
    // Turn two saw the tool result the loop appended after turn one.
    expect(turns[1]!.messages.some((m) => m.role === 'tool')).toBe(true)
    expect(turns[1]!.response.content).toBe('done')
  })

  test('fires for the forced final inference with no tools', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        calls++
        if (req.tools && req.tools.length > 0) {
          return stubResponse({
            tool_calls: [{ id: `call_${calls}`, name: 'noop', arguments: { n: calls } }],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'Final summary.' })
      },
    }

    const turns: ModelTurn[] = []
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:model-turn-forced',
    })

    await agent.run('loop forever', { maxTurns: 2, events: { onModelTurn: (t) => turns.push(t) } })

    expect(turns).toHaveLength(3)
    expect(turns[2]!.tools).toEqual([])
    expect(turns[2]!.response.content).toBe('Final summary.')
  })
})
