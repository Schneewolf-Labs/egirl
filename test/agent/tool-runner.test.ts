import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { ChatRequest, ChatResponse, LLMProvider, ToolCall } from '../../src/providers/types'
import type { ToolResult } from '../../src/tools'
import { createToolExecutor } from '../../src/tools/executor'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

function makeEchoExecutor() {
  const executor = createToolExecutor()
  executor.register({
    definition: {
      name: 'echo',
      description: 'echoes its argument',
      parameters: { type: 'object', properties: { v: { type: 'string' } } },
    },
    execute: async (params) => ({ success: true, output: `echo:${String(params.v)}` }),
  })
  return executor
}

describe('tool call execution', () => {
  test('pairs each tool call with a tool result message in order', async () => {
    let chatCalls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        chatCalls++
        if (chatCalls === 1) {
          return stubResponse({
            tool_calls: [
              { id: 'call_a', name: 'echo', arguments: { v: 'first' } },
              { id: 'call_b', name: 'echo', arguments: { v: 'second' } },
            ],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'done' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeEchoExecutor(),
      localProvider: provider,
      sessionId: 'test:pairing',
    })

    const response = await agent.run('go')

    expect(response.content).toBe('done')

    const messages = agent.getContext().messages
    const assistantWithCalls = messages.find((m) => m.tool_calls && m.tool_calls.length > 0)
    expect(assistantWithCalls?.role).toBe('assistant')

    const toolMessages = messages.filter((m) => m.role === 'tool')
    expect(toolMessages.length).toBe(2)
    expect(toolMessages[0]?.tool_call_id).toBe('call_a')
    expect(toolMessages[0]?.content).toBe('echo:first')
    expect(toolMessages[1]?.tool_call_id).toBe('call_b')
    expect(toolMessages[1]?.content).toBe('echo:second')
  })

  test('emits tool lifecycle events with call details and results', async () => {
    let chatCalls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        chatCalls++
        if (chatCalls === 1) {
          return stubResponse({
            tool_calls: [{ id: 'call_a', name: 'echo', arguments: { v: 'hi' } }],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'done' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeEchoExecutor(),
      localProvider: provider,
      sessionId: 'test:events',
    })

    const started: ToolCall[][] = []
    const completed: Array<{ id: string; name: string; result: ToolResult }> = []

    await agent.run('go', {
      events: {
        onToolCallStart: (calls) => {
          started.push(calls)
        },
        onToolCallComplete: (callId, name, result) => {
          completed.push({ id: callId, name, result })
        },
      },
    })

    expect(started.length).toBe(1)
    expect(started[0]?.[0]?.name).toBe('echo')
    expect(completed.length).toBe(1)
    expect(completed[0]?.id).toBe('call_a')
    expect(completed[0]?.name).toBe('echo')
    expect(completed[0]?.result.success).toBe(true)
    expect(completed[0]?.result.output).toBe('echo:hi')
  })

  test('warns when the model repeats an identical tool call', async () => {
    let chatCalls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        chatCalls++
        if (chatCalls <= 2) {
          return stubResponse({
            tool_calls: [{ id: `call_${chatCalls}`, name: 'noop', arguments: { x: 1 } }],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'done' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:dupes',
    })

    await agent.run('go')

    const messages = agent.getContext().messages
    const warnings = messages.filter(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('[Warning: You called noop'),
    )
    expect(warnings.length).toBe(1)
  })

  test('skips tool execution when onBeforeToolExec returns false', async () => {
    let executed = false
    const executor = createToolExecutor()
    executor.register({
      definition: {
        name: 'guarded',
        description: 'should not run',
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => {
        executed = true
        return { success: true, output: 'ran' }
      },
    })

    let chatCalls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        chatCalls++
        if (chatCalls === 1) {
          return stubResponse({
            tool_calls: [{ id: 'call_a', name: 'guarded', arguments: {} }],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'done' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: executor,
      localProvider: provider,
      sessionId: 'test:hook-skip',
    })

    const afterResults: ToolResult[] = []
    await agent.run('go', {
      events: {
        onBeforeToolExec: () => false,
        onAfterToolExec: (_call, result) => {
          afterResults.push(result)
        },
      },
    })

    expect(executed).toBe(false)
    expect(afterResults.length).toBe(1)
    expect(afterResults[0]?.success).toBe(false)
    expect(afterResults[0]?.output).toContain('skipped by hook')

    const toolMessages = agent.getContext().messages.filter((m) => m.role === 'tool')
    expect(toolMessages.length).toBe(1)
    expect(toolMessages[0]?.content).toContain('skipped by hook')
  })

  test('truncates oversized tool output at ingestion', async () => {
    const hugeOutput = 'x'.repeat(100_000)
    const executor = createToolExecutor()
    executor.register({
      definition: {
        name: 'firehose',
        description: 'returns a huge output',
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => ({ success: true, output: hugeOutput }),
    })

    let chatCalls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        chatCalls++
        if (chatCalls === 1) {
          return stubResponse({
            tool_calls: [{ id: 'call_a', name: 'firehose', arguments: {} }],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'done' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: executor,
      localProvider: provider,
      sessionId: 'test:truncate',
    })

    await agent.run('go')

    const toolMessage = agent.getContext().messages.find((m) => m.role === 'tool')
    expect(typeof toolMessage?.content).toBe('string')
    const content = toolMessage?.content as string
    expect(content.length).toBeLessThan(hugeOutput.length)
    expect(content).toContain('[Output truncated')
  })

  test('uses the batch execution path when no per-tool hooks are registered', async () => {
    const order: string[] = []
    const executor = createToolExecutor()
    executor.register({
      definition: {
        name: 'track',
        description: 'records execution',
        parameters: { type: 'object', properties: { n: { type: 'number' } } },
      },
      execute: async (params) => {
        order.push(`run:${String(params.n)}`)
        return { success: true, output: `ok:${String(params.n)}` }
      },
    })

    let chatCalls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        chatCalls++
        if (chatCalls === 1) {
          return stubResponse({
            tool_calls: [
              { id: 'call_1', name: 'track', arguments: { n: 1 } },
              { id: 'call_2', name: 'track', arguments: { n: 2 } },
            ],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'done' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: executor,
      localProvider: provider,
      sessionId: 'test:batch',
    })

    // No events handler — exercises the executeAll fast path
    const response = await agent.run('go')

    expect(response.content).toBe('done')
    expect(order).toEqual(['run:1', 'run:2'])
    const toolMessages = agent.getContext().messages.filter((m) => m.role === 'tool')
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['call_1', 'call_2'])
  })
})
