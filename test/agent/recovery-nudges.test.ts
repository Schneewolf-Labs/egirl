/**
 * Recovery nudges: stranded tool calls, empty-after-tools, and the ephemeral contract.
 *
 * The scaffolding these tests guard is invisible when it works -- a mangled call gets
 * reissued, the user never knows. What they pin down is the part that must NOT happen:
 * the model's failure and the nudge that fixed it leaking into persisted history, where
 * every future session would replay them as context.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import { ConversationStore } from '../../src/conversation/store'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

// Unrecoverable junk: no repairable name, so it genuinely strands. (The doubled-brace shape
// from Zero's incident no longer works as a fixture here -- the dialect repair fixes it and
// the call executes, which is the point of that fix.)
const MANGLED = '<tool_call>\n{"nmae": ??? broken beyond repair}\n</tool_call>'

const stores: ConversationStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})

function makeStore(ws: string): ConversationStore {
  const store = new ConversationStore(`${ws}/conv.db`, { retentionDays: 1, maxMessages: 100 })
  stores.push(store)
  return store
}

describe('stranded tool call recovery', () => {
  test('retries up to three times, then gives up gracefully', async () => {
    // A model that mangles the same call forever. Unrecoverable junk (no name to repair),
    // so each nudge fails and the cap decides when to stop.
    let calls = 0
    const junk = '<tool_call>\n{"nmae": ???}\n</tool_call>'
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        return stubResponse({ content: junk })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:stranded-cap',
    })
    await agent.run('do the thing')
    // 1 original + 3 nudged retries.
    expect(calls).toBe(4)
  })

  test('a recovered pair is stripped from persisted history', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        // Mangled once, clean answer on the reissue.
        if (calls === 1) return stubResponse({ content: MANGLED })
        return stubResponse({ content: 'done, ran the tool' })
      },
    }
    const ws = makeWorkspace()
    const store = makeStore(ws)
    const agent = new AgentLoop({
      config: makeConfig(ws),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:ephemeral',
      conversationStore: store,
    })
    await agent.run('do the thing')

    const persisted = store.loadMessages('test:ephemeral')
    const texts = persisted.map((m) => String(m.content))
    // The failure never reaches disk; the conversation reads as if it never happened.
    expect(texts.some((t) => t.includes('could not be parsed'))).toBe(false)
    expect(texts.some((t) => t.includes('nmae'))).toBe(false)
    // The real exchange does.
    expect(texts.some((t) => t.includes('do the thing'))).toBe(true)
    expect(texts.some((t) => t.includes('done, ran the tool'))).toBe(true)
  })
})

describe('empty response after tools', () => {
  test('the model is pointed back at its tool results', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        calls++
        // Turn 1: a tool call. Turn 2: nothing at all. Turn 3 (after the nudge): the answer.
        if (calls === 1) {
          return stubResponse({
            tool_calls: [{ id: 'c1', name: 'noop', arguments: {} }],
            finish_reason: 'tool_calls',
          })
        }
        if (calls === 2) {
          // The nudge must actually be in the request for the recovery to work end to end.
          expect(JSON.stringify(req.messages)).not.toContain('empty response')
          return stubResponse({ content: '' })
        }
        expect(JSON.stringify(req.messages)).toContain('empty response')
        return stubResponse({ content: 'the tool returned nothing unusual' })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:empty-after-tools',
    })
    const response = await agent.run('check it')
    expect(calls).toBe(3)
    expect(response.content).toBe('the tool returned nothing unusual')
  })

  test('an empty FIRST response is not nudged (no tools ran)', async () => {
    // That failure class belongs to the empty-response guard, not this nudge -- re-prompting
    // "process the tool results above" when there are none would gaslight the model.
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        return stubResponse({ content: '' })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:empty-first',
    })
    await agent.run('hello?')
    expect(calls).toBe(1)
  })
})
