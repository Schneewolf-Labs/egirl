import { describe, expect, test } from 'bun:test'
import {
  estimateMessageTokens,
  fitToContextWindow,
  truncateToolResultSync,
} from '../../src/agent/context-window'
import type { ChatMessage } from '../../src/providers/types'

describe('estimateMessageTokens', () => {
  test('estimates tokens for simple text message', () => {
    const msg: ChatMessage = { role: 'user', content: 'Hello world' }
    const tokens = estimateMessageTokens(msg)
    // 11 chars / 3.5 ≈ 4, + 4 overhead = 8
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(20)
  })

  test('estimates tokens for multipart content', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
      ],
    }
    const tokens = estimateMessageTokens(msg)
    // text tokens + 1000 for image + 4 overhead
    expect(tokens).toBeGreaterThanOrEqual(1004)
  })

  test('estimates tokens for message with tool calls', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: 'Let me read that.',
      tool_calls: [{ id: 'call_0', name: 'read_file', arguments: { path: '/test.txt' } }],
    }
    const tokens = estimateMessageTokens(msg)
    // content tokens + tool call tokens + 15 overhead per call + 4 base
    expect(tokens).toBeGreaterThan(10)
  })

  test('adds overhead for tool_call_id', () => {
    const withId: ChatMessage = { role: 'tool', content: 'result', tool_call_id: 'call_0' }
    const without: ChatMessage = { role: 'tool', content: 'result' }
    expect(estimateMessageTokens(withId)).toBeGreaterThan(estimateMessageTokens(without))
  })

  test('handles empty content', () => {
    const msg: ChatMessage = { role: 'user', content: '' }
    const tokens = estimateMessageTokens(msg)
    expect(tokens).toBe(4) // just overhead
  })
})

describe('truncateToolResultSync', () => {
  test('returns content unchanged when within budget', () => {
    const content = 'short result'
    expect(truncateToolResultSync(content, 1000)).toBe(content)
  })

  test('truncates content exceeding token budget', () => {
    const content = 'x'.repeat(50000) // ~14286 tokens at 3.5 chars/token
    const result = truncateToolResultSync(content, 100)
    // 100 tokens * 3.5 chars/token = 350 chars max
    expect(result.length).toBeLessThan(1000)
    expect(result).toContain('[Output truncated')
    expect(result).toContain('estimated tokens exceeded 100 token limit')
  })

  test('preserves empty content', () => {
    expect(truncateToolResultSync('', 100)).toBe('')
  })
})

describe('fitToContextWindow', () => {
  const smallConfig = {
    contextLength: 200,
    reserveForOutput: 50,
    maxToolResultTokens: 100,
  }

  test('returns all messages when they fit', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]
    const {
      messages: result,
      wasTrimmed,
      droppedMessages,
    } = await fitToContextWindow('System prompt', messages, [], {
      contextLength: 4096,
      reserveForOutput: 200,
    })
    expect(result).toHaveLength(2)
    expect(result[0].content).toBe('Hi')
    expect(result[1].content).toBe('Hello!')
    expect(wasTrimmed).toBe(false)
    expect(droppedMessages).toHaveLength(0)
  })

  test('trims older messages when context is too small', async () => {
    const messages: ChatMessage[] = []
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: 'user',
        content: `Message ${i} with some extra padding text to use tokens`,
      })
      messages.push({
        role: 'assistant',
        content: `Response ${i} with some extra padding text to use tokens`,
      })
    }

    const {
      messages: result,
      wasTrimmed,
      droppedMessages,
    } = await fitToContextWindow('System', messages, [], smallConfig)
    // Should have fewer messages than input
    expect(result.length).toBeLessThan(messages.length)
    // Should include truncation/compaction notice
    const hasNotice = result.some(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        (m.content.includes('trimmed') || m.content.includes('summarized')),
    )
    expect(hasNotice).toBe(true)
    expect(wasTrimmed).toBe(true)
    expect(droppedMessages.length).toBeGreaterThan(0)
  })

  test('keeps most recent messages when trimming', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'First message that is old' },
      { role: 'assistant', content: 'First response that is old' },
      {
        role: 'user',
        content: 'Second message that is old and has lots of extra text to fill up the window',
      },
      {
        role: 'assistant',
        content: 'Second response that is also old with lots of text filling the window',
      },
      { role: 'user', content: 'Recent message' },
      { role: 'assistant', content: 'Recent reply' },
    ]

    const { messages: result } = await fitToContextWindow('Sys', messages, [], smallConfig)
    const contents = result.map((m) => m.content)
    // Recent messages should be preserved
    expect(contents).toContain('Recent message')
    expect(contents).toContain('Recent reply')
  })

  test('groups assistant tool calls with tool results', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read the file' },
      {
        role: 'assistant',
        content: 'Reading...',
        tool_calls: [{ id: 'call_0', name: 'read_file', arguments: { path: 'test.txt' } }],
      },
      { role: 'tool', content: 'file contents here', tool_call_id: 'call_0' },
      { role: 'assistant', content: 'The file contains: file contents here' },
    ]

    const { messages: result } = await fitToContextWindow('System', messages, [], {
      contextLength: 4096,
      reserveForOutput: 200,
    })
    // All messages should fit in a large window
    expect(result).toHaveLength(4)
  })

  test('truncates oversized tool results', async () => {
    const longResult = 'x'.repeat(50000)
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read big file' },
      {
        role: 'assistant',
        content: 'Reading...',
        tool_calls: [{ id: 'call_0', name: 'read_file', arguments: { path: 'big.txt' } }],
      },
      { role: 'tool', content: longResult, tool_call_id: 'call_0' },
    ]

    const { messages: result } = await fitToContextWindow('Sys', messages, [], {
      contextLength: 8192,
      reserveForOutput: 200,
      maxToolResultTokens: 100,
    })

    const toolMsg = result.find((m) => m.role === 'tool')
    if (toolMsg && typeof toolMsg.content === 'string') {
      expect(toolMsg.content.length).toBeLessThan(longResult.length)
      expect(toolMsg.content).toContain('[Output truncated')
    }
  })

  test('returns at least last user message when budget is tiny', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'A very long system prompt that takes all the budget' },
    ]

    const { messages: result } = await fitToContextWindow(
      'A'.repeat(1000), // huge system prompt
      messages,
      [],
      { contextLength: 100, reserveForOutput: 50 },
    )
    // Should return at least the last user message
    expect(result.length).toBeGreaterThanOrEqual(1)
  })
})

describe('a user turn always survives trimming', () => {
  /**
   * Qwen3's chat template raises `No user query found in messages` when handed a conversation
   * with no user turn, and llama.cpp answers 400 — the whole request fails.
   *
   * A long unbounded run reaches exactly that shape. It has ONE user message (the task prompt)
   * followed by dozens of assistant/tool turns, so once the head group is dropped for exceeding
   * 30% of the budget, every surviving message is an assistant or a tool result. Observed in
   * production: a reverse-engineering task failed three runs in a row on that 400 and
   * auto-paused, hours after its conversation outgrew the head.
   */
  function unboundedRun(turns: number): ChatMessage[] {
    // A big task prompt, then nothing but assistant/tool traffic — the real shape.
    const msgs: ChatMessage[] = [{ role: 'user', content: `TASK. ${'context '.repeat(400)}` }]
    for (let i = 0; i < turns; i++) {
      msgs.push({ role: 'assistant', content: `step ${i}: ${'analysis '.repeat(60)}` })
      msgs.push({ role: 'tool', content: `result ${i}: ${'output '.repeat(60)}` })
    }
    return msgs
  }

  test('keeps a user message even when the head group is dropped', async () => {
    const messages = unboundedRun(40)
    const result = await fitToContextWindow('You are an agent.', messages, [], {
      contextLength: 4000,
      reserveForOutput: 500,
    })
    expect(result.wasTrimmed).toBe(true)
    // The actual invariant: whatever else got dropped, the template must find a user turn.
    expect(result.messages.some((m) => m.role === 'user')).toBe(true)
  })

  test('holds across a range of budgets, since the failure depends on where the trim lands', async () => {
    // The bug was intermittent in production precisely because it depended on the boundary.
    for (const contextLength of [1500, 3000, 6000, 12000]) {
      const result = await fitToContextWindow('You are an agent.', unboundedRun(40), [], {
        contextLength,
        reserveForOutput: 400,
      })
      expect(result.messages.some((m) => m.role === 'user')).toBe(true)
    }
  })
})
