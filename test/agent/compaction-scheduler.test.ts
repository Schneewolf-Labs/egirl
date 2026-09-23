/**
 * CompactionScheduler under overlapping drain/schedule and reset.
 *
 * Mirrors formal/Compaction.tla: drain() must not drop a job chained on while it waited (the
 * next schedule would then start a second chain beside it and the two summaries would overwrite
 * each other), and a job that outlives reset() must not write its summary into the fresh
 * conversation's sessions row.
 */

import { describe, expect, test } from 'bun:test'
import { CompactionScheduler } from '../../src/agent/compaction'
import { type AgentContext, createAgentContext } from '../../src/agent/context'
import { ConversationHistory } from '../../src/agent/history'
import type { ConversationStore } from '../../src/conversation'
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeWorkspace, stubResponse } from './helpers'

/** A summarizer whose calls each wait for their own release, so the test orders them. */
function gatedSummarizer() {
  const releases: Array<() => void> = []
  let active = 0
  let maxActive = 0
  const provider: LLMProvider = {
    name: 'stub',
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      active++
      maxActive = Math.max(maxActive, active)
      const n = releases.length + 1
      await new Promise<void>((resolve) => releases.push(resolve))
      active--
      return stubResponse({ content: `summary ${n}` })
    },
  }
  return {
    provider,
    maxActive: () => maxActive,
    started: () => releases.length,
    release: (i: number) => releases[i]?.(),
  }
}

function makeContext(): AgentContext {
  return createAgentContext(makeConfig(makeWorkspace()), 'test:compaction', {})
}

function turn(text: string): ChatMessage[] {
  return [
    { role: 'user', content: `question ${text}` },
    { role: 'assistant', content: `answer ${text}` },
  ]
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(1)
  expect(cond()).toBe(true)
}

describe('CompactionScheduler', () => {
  test('drain keeps a job chained on while it waited, so summaries never overlap', async () => {
    const s = gatedSummarizer()
    const scheduler = new CompactionScheduler()
    const context = makeContext()
    const history = new ConversationHistory(null, context.sessionId)
    const schedule = (dropped: ChatMessage[]) => {
      context.messages.push(...dropped)
      scheduler.schedule({
        droppedMessages: dropped,
        context,
        history,
        provider: s.provider,
        memory: null,
        conversationStore: null,
      })
    }

    schedule(turn('1'))
    const draining = scheduler.drain()
    schedule(turn('2')) // chained on while drain waits for job 1
    await until(() => s.started() === 1)
    s.release(0)
    await draining

    schedule(turn('3')) // must chain behind job 2, not start beside it
    await until(() => s.started() === 2)
    await Bun.sleep(5)
    expect(s.started()).toBe(2) // job 3 is still queued behind job 2
    s.release(1)
    await until(() => s.started() === 3)
    s.release(2)
    await scheduler.drain()

    expect(s.maxActive()).toBe(1)
    expect(context.conversationSummary).toBe('summary 3')
  })

  test('a job that outlives reset does not write its summary back', async () => {
    const s = gatedSummarizer()
    const scheduler = new CompactionScheduler()
    const context = makeContext()
    const history = new ConversationHistory(null, context.sessionId)
    const written: string[] = []
    const store = {
      updateSummary: (_id: string, summary: string) => written.push(summary),
    } as unknown as ConversationStore

    const dropped = turn('old')
    context.messages.push(...dropped)
    scheduler.schedule({
      droppedMessages: dropped,
      context,
      history,
      provider: s.provider,
      memory: null,
      conversationStore: store,
    })
    await until(() => s.started() === 1)
    scheduler.reset()
    s.release(0)
    await Bun.sleep(5)

    expect(written).toEqual([])
    expect(context.conversationSummary).toBeUndefined()
  })
})
