import { describe, expect, test } from 'bun:test'
import { clearStaleRecalls, estimateMessageTokens } from '../../src/agent/context-window'
import { RECALL_PREFIX } from '../../src/agent/recall'
import type { ChatMessage } from '../../src/providers/types'

function recall(text: string): ChatMessage {
  return { role: 'user', content: `${RECALL_PREFIX}\n${text}` }
}

const LONG = 'a remembered fact about the project. '.repeat(60)

describe('clearStaleRecalls', () => {
  test('blanks recalls outside the protected tail and keeps the recent one verbatim', () => {
    const messages: ChatMessage[] = [
      recall(LONG),
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first reply' },
      recall(`${LONG} newer`),
      { role: 'user', content: 'second question' },
    ]
    const counts = messages.map(estimateMessageTokens)
    // Protect a tail that covers the second recall but not the first.
    const { messages: out, clearedCount } = clearStaleRecalls(messages, counts, 700)

    expect(clearedCount).toBe(1)
    expect(out[0]?.content).toBe(`${RECALL_PREFIX}\n[cleared to make room]`)
    expect(out[3]?.content).toBe(`${RECALL_PREFIX}\n${LONG} newer`)
    // Non-recall turns are untouched and the array shape is preserved.
    expect(out.length).toBe(messages.length)
    expect(out[1]).toBe(messages[1])
  })

  test('is idempotent and leaves ordinary user turns alone', () => {
    const messages: ChatMessage[] = [
      recall(LONG),
      { role: 'user', content: LONG },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'now?' },
    ]
    const counts = messages.map(estimateMessageTokens)
    const once = clearStaleRecalls(messages, counts, 50)
    const twice = clearStaleRecalls(once.messages, once.messages.map(estimateMessageTokens), 50)

    expect(once.clearedCount).toBe(1)
    expect(twice.clearedCount).toBe(0)
    expect(once.messages[1]?.content).toBe(LONG)
  })
})
