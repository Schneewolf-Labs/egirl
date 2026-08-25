import { describe, expect, test } from 'bun:test'
import {
  clearStaleToolOutputs,
  estimateMessageTokens,
  fitToContextWindow,
} from '../../src/agent/context-window'
import type { ChatMessage } from '../../src/providers/types'

function toolMsg(content: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: 'call_0' }
}

function callMsg(): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_0', name: 'execute_command', arguments: { command: 'xxd file' } }],
  }
}

const BIG = 'hexdump line\n'.repeat(400) // ~5.2k chars, well over CLEAR_MIN_TOKENS

describe('clearStaleToolOutputs', () => {
  test('clears old big tool outputs, keeps the protected recent tail verbatim', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'reverse this binary' },
      callMsg(),
      toolMsg(BIG), // old — clearable
      { role: 'assistant', content: 'the header says PE32' },
      callMsg(),
      toolMsg(BIG), // recent — protected
    ]
    const counts = messages.map(estimateMessageTokens)
    // Protect a tail that covers the last tool result but not the first.
    const { messages: out, clearedCount } = clearStaleToolOutputs(messages, counts, 2000)
    expect(clearedCount).toBe(1)
    expect(out[2]!.content).toContain('[Stale tool result cleared')
    expect(out[5]!.content).toBe(BIG)
    // Non-tool messages untouched
    expect(out[3]!.content).toBe('the header says PE32')
  })

  test('small results are not worth clearing', () => {
    const messages: ChatMessage[] = [
      callMsg(),
      toolMsg('ok'),
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ]
    const counts = messages.map(estimateMessageTokens)
    const { clearedCount } = clearStaleToolOutputs(messages, counts, 10)
    expect(clearedCount).toBe(0)
  })

  test('idempotent — an already-cleared marker is not re-cleared', () => {
    const messages: ChatMessage[] = [
      callMsg(),
      toolMsg(BIG),
      { role: 'assistant', content: 'noted' },
      { role: 'user', content: 'go on' },
    ]
    const counts = messages.map(estimateMessageTokens)
    const first = clearStaleToolOutputs(messages, counts, 10)
    expect(first.clearedCount).toBe(1)
    const secondCounts = first.messages.map(estimateMessageTokens)
    const second = clearStaleToolOutputs(first.messages, secondCounts, 10)
    expect(second.clearedCount).toBe(0)
  })

  test('everything inside the protected tail is untouched', () => {
    const messages: ChatMessage[] = [callMsg(), toolMsg(BIG)]
    const counts = messages.map(estimateMessageTokens)
    // Huge protection window — the whole conversation is the tail.
    const { clearedCount } = clearStaleToolOutputs(messages, counts, 1_000_000)
    expect(clearedCount).toBe(0)
  })
})

describe('fitToContextWindow with stale clearing', () => {
  test('clearing alone makes an over-budget conversation fit — nothing dropped', async () => {
    // Many turns of big stale tool output plus a modest recent tail. Budget chosen so the
    // conversation only fits once old payloads are blanked.
    const messages: ChatMessage[] = [{ role: 'user', content: 'start the analysis' }]
    for (let i = 0; i < 6; i++) {
      messages.push(callMsg(), toolMsg(BIG), {
        role: 'assistant',
        content: `finding ${i}: section ${i} mapped`,
      })
    }
    messages.push({ role: 'user', content: 'continue' })

    const result = await fitToContextWindow('system', messages, [], {
      contextLength: 8000,
      reserveForOutput: 512,
    })

    expect(result.wasTrimmed).toBe(false)
    expect(result.droppedMessages).toHaveLength(0)
    // Same shape — every turn still present.
    expect(result.messages).toHaveLength(messages.length)
    // The assistant's own findings survive verbatim while old payloads are blanked.
    const contents = result.messages.map((m) => m.content as string)
    expect(contents.some((c) => c.includes('finding 0'))).toBe(true)
    expect(
      contents.filter((c) => c.startsWith('[Stale tool result cleared')).length,
    ).toBeGreaterThan(0)
  })
})
