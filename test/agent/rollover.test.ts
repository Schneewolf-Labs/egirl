import { describe, expect, test } from 'bun:test'
import { ROLLOVER_PREFIX } from '../../src/agent/handoff'
import { AgentLoop } from '../../src/agent/loop'
import { ConversationStore } from '../../src/conversation/store'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import type { ToolExecutor } from '../../src/tools'
import { createToolExecutor } from '../../src/tools/executor'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

/**
 * Context rollover — the no-summary alternative to compaction. When the window fills, the
 * loop replaces the whole history with one mechanical handoff record instead of dropping the
 * middle and summarizing it; the transcript stays append-only in the store, and a restart
 * resumes from the record. The model can also roll over itself with new_context.
 */

const BULK = 'bulk tool output '.repeat(200) // ~3.4k chars, ~1k tokens per call

function makeBulkExecutor(): ToolExecutor {
  const executor = createToolExecutor()
  executor.register({
    definition: {
      name: 'bulk',
      description: 'returns a lot of text',
      parameters: { type: 'object', properties: {} },
    },
    execute: async () => ({ success: true, output: BULK }),
  })
  return executor
}

/** Calls `bulk` every turn until the window has rolled over at least once, then finishes. */
function fillingProvider(requests: ChatRequest[]): LLMProvider {
  let n = 0
  return {
    name: 'stub',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req)
      n++
      const rolled = req.messages.some((m) => String(m.content).startsWith(ROLLOVER_PREFIX))
      if (rolled || n >= 40) return stubResponse({ content: 'done' })
      return stubResponse({
        content: `SECRET PROSE turn ${n}`,
        tool_calls: [{ id: `c${n}`, name: 'bulk', arguments: { n } }],
        finish_reason: 'tool_calls',
      })
    },
  }
}

function smallConfig() {
  const cfg = makeConfig(makeWorkspace())
  cfg.local.contextLength = 6000
  cfg.conversation.contextCompaction = true // rollover must win over summarization
  return cfg
}

describe('automatic context rollover', () => {
  test('replaces the window with a handoff record instead of summarizing', async () => {
    const requests: ChatRequest[] = []
    const store = new ConversationStore(':memory:')
    const agent = new AgentLoop({
      config: smallConfig(),
      toolExecutor: makeBulkExecutor(),
      localProvider: fillingProvider(requests),
      sessionId: 'test:rollover',
      conversationStore: store,
    })
    await agent.run('Map the RFH header layout.', { contextRollover: true, maxTurns: 45 })

    // Some request ran on the fresh window: system prompt + the record, nothing else.
    const fresh = requests.find((r) =>
      r.messages.some((m) => String(m.content).startsWith(ROLLOVER_PREFIX)),
    )
    expect(fresh).toBeDefined()
    const history = (fresh as ChatRequest).messages.filter((m) => m.role !== 'system')
    expect(history.length).toBe(1)
    const record = String(history[0]?.content)
    expect(record).toContain('Map the RFH header layout.')
    expect(record).toContain('Pending tool results')
    expect(record).not.toContain('SECRET PROSE turn 3')

    // No summarizer ever ran, and no interior-compaction notice was sent.
    for (const r of requests) {
      const system = String(r.messages[0]?.content)
      expect(system).not.toContain('context compaction assistant')
      expect(system).not.toContain('[Conversation summary')
      expect(r.messages.some((m) => String(m.content).includes('[System notice:'))).toBe(false)
    }

    // The live context now starts at the record and continues from it.
    const live = agent.getContext().messages
    expect(String(live[0]?.content).startsWith(ROLLOVER_PREFIX)).toBe(true)
    expect(live[live.length - 1]?.content).toBe('done')

    // Append-only transcript: everything before the record is still there, then the record.
    const stored = store.loadMessages('test:rollover')
    const recordIdx = stored.findIndex((m) => String(m.content).startsWith(ROLLOVER_PREFIX))
    expect(recordIdx).toBeGreaterThan(2)
    expect(stored[0]?.content).toBe('Map the RFH header layout.')
    expect(stored.slice(0, recordIdx).some((m) => String(m.content).includes(BULK))).toBe(true)

    // A restart resumes from the record, not from the whole transcript.
    const revived = new AgentLoop({
      config: smallConfig(),
      toolExecutor: makeBulkExecutor(),
      localProvider: fillingProvider([]),
      sessionId: 'test:rollover',
      conversationStore: store,
    })
    const revivedMessages = revived.getContext().messages
    expect(String(revivedMessages[0]?.content).startsWith(ROLLOVER_PREFIX)).toBe(true)
    expect(revivedMessages.length).toBe(stored.length - recordIdx)
  })

  test('off by default: the same run compacts with a summary', async () => {
    const requests: ChatRequest[] = []
    const agent = new AgentLoop({
      config: smallConfig(),
      toolExecutor: makeBulkExecutor(),
      localProvider: fillingProvider(requests),
      sessionId: 'test:no-rollover',
    })
    await agent.run('Map the RFH header layout.', { maxTurns: 45 })
    expect(
      requests.some((r) => r.messages.some((m) => String(m.content).startsWith(ROLLOVER_PREFIX))),
    ).toBe(false)
    expect(
      requests.some((r) => r.messages.some((m) => String(m.content).includes('[System notice:'))),
    ).toBe(true)
  })
})

describe('new_context tool', () => {
  test('rolls over after the batch, carrying the handoff and the batch results', async () => {
    const requests: ChatRequest[] = []
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        requests.push(req)
        n++
        if (n === 1) {
          return stubResponse({
            content: 'OLD PROSE',
            tool_calls: [{ id: 'c1', name: 'noop', arguments: {} }],
            finish_reason: 'tool_calls',
          })
        }
        if (n === 2) {
          return stubResponse({
            tool_calls: [
              { id: 'c2', name: 'noop', arguments: { again: true } },
              { id: 'c3', name: 'new_context', arguments: { handoff: 'Next: run the tests.' } },
            ],
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
      sessionId: 'test:new-context',
    })
    await agent.run('start', { contextRollover: true })

    // The tool is offered only when rollover is on.
    expect(requests[0]?.tools?.some((t) => t.name === 'new_context')).toBe(true)
    expect(requests[0]?.tools?.some((t) => t.name === 'context_remaining')).toBe(true)

    const third = requests[2] as ChatRequest
    const history = third.messages.filter((m) => m.role !== 'system')
    expect(history.length).toBe(1)
    const record = String(history[0]?.content)
    expect(record).toContain('You requested a fresh context window')
    expect(record).toContain('Next: run the tests.')
    expect(record).toContain('start')
    expect(record).toContain('Context rollover scheduled')
    expect(record).not.toContain('OLD PROSE')
  })

  test('the tools are not offered when rollover is off', async () => {
    const requests: ChatRequest[] = []
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        requests.push(req)
        return stubResponse({ content: 'done' })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:no-tools',
    })
    await agent.run('start')
    expect(requests[0]?.tools?.some((t) => t.name === 'new_context')).toBe(false)
  })
})

describe('context_remaining tool', () => {
  test('reports the last prompt size against the window', async () => {
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        n++
        if (n === 1) {
          return stubResponse({
            tool_calls: [{ id: 'c1', name: 'context_remaining', arguments: {} }],
            finish_reason: 'tool_calls',
            usage: { input_tokens: 8192, output_tokens: 1 },
          })
        }
        return stubResponse({ content: 'done' })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:remaining',
    })
    await agent.run('start', { contextRollover: true })
    const result = agent.getContext().messages.find((m) => m.role === 'tool')
    expect(String(result?.content)).toContain('8192 of 32768 tokens used (25%)')
  })
})

describe('checkpoint before rollover', () => {
  test('context pressure fires the checkpoint once per window even with no interval', async () => {
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        n++
        if (n >= 6) return stubResponse({ content: 'done' })
        return stubResponse({
          tool_calls: [{ id: `c${n}`, name: 'noop', arguments: { n } }],
          finish_reason: 'tool_calls',
          usage: { input_tokens: 30000, output_tokens: 1 },
        })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:pressure',
    })
    await agent.run('go', { contextRollover: true, maxTurns: 8 })
    const nudges = agent
      .getContext()
      .messages.filter((m) => String(m.content).includes('about to roll over'))
    expect(nudges.length).toBe(1)
  })
})
