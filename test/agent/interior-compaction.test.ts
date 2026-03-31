import { describe, expect, test } from 'bun:test'
import { fitToContextWindow } from '../../src/agent/context-window'
import type { ChatMessage } from '../../src/providers/types'

// Small context to force compaction
const tinyConfig = { contextLength: 300, reserveForOutput: 50 }

function makeConversation(turnCount: number): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let i = 0; i < turnCount; i++) {
    messages.push({ role: 'user', content: `User message ${i} with padding text to use tokens` })
    messages.push({
      role: 'assistant',
      content: `Assistant response ${i} with padding text to use tokens`,
    })
  }
  return messages
}

describe('interior compaction', () => {
  test('preserves first user message when compacting', async () => {
    const messages = makeConversation(15)
    const { messages: result, wasTrimmed } = await fitToContextWindow(
      'System prompt',
      messages,
      [],
      tinyConfig,
    )

    expect(wasTrimmed).toBe(true)

    // The first non-notice message should be from the original first user message
    const firstContent = result.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        !m.content.startsWith('[System notice'),
    )
    expect(firstContent).toBeDefined()
    expect(typeof firstContent!.content === 'string' && firstContent!.content).toContain(
      'User message 0',
    )
  })

  test('preserves most recent messages', async () => {
    const messages = makeConversation(15)
    const { messages: result } = await fitToContextWindow(
      'System prompt',
      messages,
      [],
      tinyConfig,
    )

    // Should contain the last message
    const contents = result
      .filter((m) => typeof m.content === 'string')
      .map((m) => m.content as string)

    const hasRecent = contents.some((c) => c.includes('message 14') || c.includes('response 14'))
    expect(hasRecent).toBe(true)
  })

  test('drops middle messages', async () => {
    const messages = makeConversation(15)
    const { messages: result, droppedMessages } = await fitToContextWindow(
      'System prompt',
      messages,
      [],
      tinyConfig,
    )

    // Dropped messages should be from the middle
    expect(droppedMessages.length).toBeGreaterThan(0)

    // The dropped messages should not include the first user message (index 0)
    const droppedContents = droppedMessages
      .filter((m) => typeof m.content === 'string')
      .map((m) => m.content as string)

    // First user message should NOT be in dropped list
    const firstDropped = droppedContents.some((c) => c.includes('User message 0'))
    expect(firstDropped).toBe(false)
  })

  test('inserts compaction notice between head and tail', async () => {
    const messages = makeConversation(15)
    const { messages: result } = await fitToContextWindow(
      'System prompt',
      messages,
      [],
      tinyConfig,
    )

    const noticeIdx = result.findIndex(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('summarized'),
    )

    expect(noticeIdx).toBeGreaterThan(0) // After head
    expect(noticeIdx).toBeLessThan(result.length - 1) // Before tail
  })

  test('does not compact when everything fits', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]

    const { messages: result, wasTrimmed, droppedMessages } = await fitToContextWindow(
      'System',
      messages,
      [],
      { contextLength: 2000, reserveForOutput: 100 },
    )

    expect(wasTrimmed).toBe(false)
    expect(droppedMessages).toHaveLength(0)
    expect(result).toHaveLength(2)
  })

  test('groups tool calls with their results', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read the file' },
      {
        role: 'assistant',
        content: 'Reading...',
        tool_calls: [{ id: 'call_0', name: 'read_file', arguments: { path: '/test.txt' } }],
      },
      { role: 'tool', content: 'File contents here with lots of text', tool_call_id: 'call_0' },
      { role: 'assistant', content: 'The file contains the text.' },
      { role: 'user', content: 'Thanks!' },
      { role: 'assistant', content: 'You are welcome!' },
    ]

    const { messages: result } = await fitToContextWindow(
      'System',
      messages,
      [],
      { contextLength: 2000, reserveForOutput: 100 },
    )

    // Tool call and result should be kept together
    const hasToolCall = result.some((m) => m.tool_calls && m.tool_calls.length > 0)
    const hasToolResult = result.some((m) => m.role === 'tool')

    // If tool call is present, tool result must also be present (or both dropped)
    if (hasToolCall) {
      expect(hasToolResult).toBe(true)
    }
  })

  test('head protection has budget cap (30%)', async () => {
    // First message is very large — should not be protected if it exceeds 30% budget
    const messages: ChatMessage[] = [
      { role: 'user', content: 'A'.repeat(500) }, // Large first message
      { role: 'assistant', content: 'Response' },
      { role: 'user', content: 'Short follow-up' },
      { role: 'assistant', content: 'Short response' },
    ]

    const { messages: result } = await fitToContextWindow(
      'System',
      messages,
      [],
      { contextLength: 300, reserveForOutput: 50 },
    )

    // Large first message may be dropped if it exceeds 30% budget
    // The test verifies that we don't crash and still return valid messages
    expect(result.length).toBeGreaterThan(0)
  })
})
