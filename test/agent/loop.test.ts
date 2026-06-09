import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentLoop } from '../../src/agent/loop'
import type { RuntimeConfig } from '../../src/config'
import { ConversationStore } from '../../src/conversation/store'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { createToolExecutor } from '../../src/tools/executor'

function makeConfig(workspacePath: string): RuntimeConfig {
  return {
    theme: 'egirl',
    thinking: { level: 'off', showThinking: true },
    workspace: { path: workspacePath },
    local: {
      endpoint: 'http://localhost:1',
      model: 'test',
      contextLength: 32768,
      maxConcurrent: 2,
      staleStreamTimeoutMs: 90000,
    },
    remote: {},
    routing: {
      disabled: false,
      default: 'local',
      escalationThreshold: 0.4,
      alwaysLocal: [],
      alwaysRemote: [],
    },
    channels: {},
    conversation: {
      enabled: false,
      maxAgeDays: 30,
      maxMessages: 1000,
      compactOnStartup: false,
      contextCompaction: false,
    },
    memory: {
      proactiveRetrieval: false,
      scoreThreshold: 0.35,
      maxResults: 5,
      maxTokensBudget: 2000,
      autoExtract: false,
      extractionMinMessages: 2,
      extractionMaxPerTurn: 5,
    },
    safety: {
      enabled: false,
      commandFilter: { enabled: false, mode: 'block', blockedPatterns: [], extraAllowed: [] },
      pathSandbox: { enabled: false, allowedPaths: [] },
      sensitiveFiles: { enabled: false, patterns: [] },
      auditLog: { enabled: false },
      confirmation: { enabled: false, tools: [] },
      permissionRules: { allow: [], deny: [] },
    },
    energy: { enabled: false, maxEnergy: 20, regenPerHour: 10 },
    tasks: {
      enabled: false,
      tickIntervalMs: 30000,
      maxActiveTasks: 20,
      maxConcurrentTasks: 1,
      taskTimeoutMs: 300000,
      discoveryEnabled: false,
      discoveryIntervalMs: 60000,
      idleThresholdMs: 300000,
      heartbeat: { enabled: false, schedule: '0 9 * * 1-5' },
    },
    transcript: { enabled: false, path: '' },
    tools: {
      files: false,
      exec: false,
      git: false,
      memory: false,
      browser: false,
      github: false,
      tasks: false,
      codeAgent: false,
      webResearch: false,
      screenshot: false,
    },
    skills: { dirs: [] },
  } as RuntimeConfig
}

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'egirl-loop-test-'))
}

function makeExecutorWithNoop() {
  const executor = createToolExecutor()
  executor.register({
    definition: {
      name: 'noop',
      description: 'does nothing',
      parameters: { type: 'object', properties: {} },
    },
    execute: async () => ({ success: true, output: 'ok' }),
  })
  return executor
}

function stubResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content: '',
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'stub',
    finish_reason: 'stop',
    ...overrides,
  }
}

describe('AgentLoop max turns exhaustion', () => {
  test('forces a final no-tools response instead of reusing stale history', async () => {
    let callCount = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        callCount++
        // While tools are offered, keep calling them — exhausting maxTurns
        if (req.tools && req.tools.length > 0) {
          return stubResponse({
            tool_calls: [{ id: `call_${callCount}`, name: 'noop', arguments: { n: callCount } }],
            finish_reason: 'tool_calls',
          })
        }
        // Forced final inference offers no tools
        return stubResponse({ content: 'Final summary of progress.' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:maxturns',
    })

    const response = await agent.run('do something', { maxTurns: 2 })

    expect(response.content).toBe('Final summary of progress.')
    expect(response.turns).toBe(2)
    // 2 tool turns + 1 forced final inference
    expect(callCount).toBe(3)
    // The forced response is recorded in context as the closing assistant message
    const messages = agent.getContext().messages
    expect(messages[messages.length - 1]?.content).toBe('Final summary of progress.')
  })
})

describe('AgentLoop error persistence', () => {
  test('persists the user message when the provider throws', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        throw new Error('401 unauthorized')
      },
    }

    const store = new ConversationStore(':memory:')
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:err',
      conversationStore: store,
    })

    await expect(agent.run('important message')).rejects.toThrow('401 unauthorized')

    const persisted = store.loadMessages('test:err')
    expect(persisted.length).toBe(1)
    expect(persisted[0]?.role).toBe('user')
    expect(persisted[0]?.content).toBe('important message')
  })
})

describe('AgentLoop abort', () => {
  test('returns aborted flag without calling the provider when pre-aborted', async () => {
    let called = false
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        called = true
        return stubResponse({ content: 'should not happen' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:abort',
    })

    const controller = new AbortController()
    controller.abort()

    const response = await agent.run('hello', { signal: controller.signal })

    expect(response.aborted).toBe(true)
    expect(response.content).toBe('')
    expect(called).toBe(false)
  })

  test('skips remaining tool calls after abort and keeps results paired', async () => {
    const controller = new AbortController()
    let chatCalls = 0

    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        chatCalls++
        if (chatCalls === 1) {
          return stubResponse({
            tool_calls: [
              { id: 'call_a', name: 'noop', arguments: { step: 1 } },
              { id: 'call_b', name: 'noop', arguments: { step: 2 } },
            ],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'done' })
      },
    }

    const executor = createToolExecutor()
    executor.register({
      definition: {
        name: 'noop',
        description: 'aborts the run on first execution',
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => {
        controller.abort()
        return { success: true, output: 'ok' }
      },
    })

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: executor,
      localProvider: provider,
      sessionId: 'test:abort-tools',
    })

    // An events handler forces the serial tool path where per-call abort applies
    const response = await agent.run('go', {
      signal: controller.signal,
      events: { onAfterToolExec: () => {} },
    })

    expect(response.aborted).toBe(true)

    // Both tool calls have paired tool results in context
    const messages = agent.getContext().messages
    const toolMessages = messages.filter((m) => m.role === 'tool')
    expect(toolMessages.length).toBe(2)
    expect(toolMessages[1]?.content).toContain('Skipped')

    // No further inference happened after abort
    expect(chatCalls).toBe(1)
  })
})
