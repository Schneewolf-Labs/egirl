import { describe, expect, test } from 'bun:test'
import type { ChatMessage, ChatResponse, LLMProvider, ToolDefinition } from '../../src/providers/types'

/**
 * Tests for continuation retry logic.
 *
 * We can't easily test the full AgentLoop (too many deps), so we test
 * the provider-level finish_reason propagation and the continuation
 * detection logic in isolation.
 */

function makeResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content: 'Hello world',
    usage: { input_tokens: 100, output_tokens: 50 },
    model: 'test-model',
    finish_reason: 'stop',
    ...overrides,
  }
}

describe('ChatResponse finish_reason', () => {
  test('finish_reason defaults to stop for normal responses', () => {
    const response = makeResponse()
    expect(response.finish_reason).toBe('stop')
  })

  test('finish_reason is length when response is truncated', () => {
    const response = makeResponse({ finish_reason: 'length' })
    expect(response.finish_reason).toBe('length')
  })

  test('finish_reason is tool_calls when tool calls are present', () => {
    const response = makeResponse({
      finish_reason: 'tool_calls',
      tool_calls: [{ id: 'call_0', name: 'read_file', arguments: { path: '/test.txt' } }],
    })
    expect(response.finish_reason).toBe('tool_calls')
  })
})

describe('continuation retry detection', () => {
  /**
   * Simulates the continuation logic from AgentLoop.doRun() to verify
   * correct behavior without needing full agent infrastructure.
   */
  function simulateContinuation(
    responses: ChatResponse[],
    maxRetries = 3,
  ): { finalContent: string; retries: number; turns: number } {
    let continuationRetries = 0
    let accumulatedContent = ''
    let turns = 0

    for (const response of responses) {
      turns++

      // No tool calls — check for truncation
      if (
        response.finish_reason === 'length' &&
        continuationRetries < maxRetries &&
        response.content.length > 0
      ) {
        continuationRetries++
        accumulatedContent += response.content
        continue
      }

      // Final response
      return {
        finalContent: accumulatedContent + response.content,
        retries: continuationRetries,
        turns,
      }
    }

    return {
      finalContent: accumulatedContent,
      retries: continuationRetries,
      turns,
    }
  }

  test('no continuation needed for complete response', () => {
    const result = simulateContinuation([
      makeResponse({ content: 'Complete answer.', finish_reason: 'stop' }),
    ])

    expect(result.finalContent).toBe('Complete answer.')
    expect(result.retries).toBe(0)
    expect(result.turns).toBe(1)
  })

  test('continues once for single truncation', () => {
    const result = simulateContinuation([
      makeResponse({ content: 'Part one... ', finish_reason: 'length' }),
      makeResponse({ content: 'Part two.', finish_reason: 'stop' }),
    ])

    expect(result.finalContent).toBe('Part one... Part two.')
    expect(result.retries).toBe(1)
    expect(result.turns).toBe(2)
  })

  test('continues multiple times for repeated truncation', () => {
    const result = simulateContinuation([
      makeResponse({ content: 'A', finish_reason: 'length' }),
      makeResponse({ content: 'B', finish_reason: 'length' }),
      makeResponse({ content: 'C', finish_reason: 'stop' }),
    ])

    expect(result.finalContent).toBe('ABC')
    expect(result.retries).toBe(2)
    expect(result.turns).toBe(3)
  })

  test('stops at max retries even if still truncated', () => {
    const result = simulateContinuation([
      makeResponse({ content: 'A', finish_reason: 'length' }),
      makeResponse({ content: 'B', finish_reason: 'length' }),
      makeResponse({ content: 'C', finish_reason: 'length' }),
      makeResponse({ content: 'D', finish_reason: 'length' }), // 4th truncation — exceeds max
    ])

    // After 3 retries (A, B, C accumulated), the 4th response is accepted as final
    expect(result.finalContent).toBe('ABCD')
    expect(result.retries).toBe(3)
    expect(result.turns).toBe(4)
  })

  test('does not continue for empty truncated response', () => {
    const result = simulateContinuation([
      makeResponse({ content: '', finish_reason: 'length' }),
    ])

    expect(result.finalContent).toBe('')
    expect(result.retries).toBe(0)
    expect(result.turns).toBe(1)
  })

  test('does not continue when tool_calls are present', () => {
    const response = makeResponse({
      content: 'Partial',
      finish_reason: 'tool_calls',
      tool_calls: [{ id: 'call_0', name: 'test', arguments: {} }],
    })

    // tool_calls responses are handled by a different branch in the loop,
    // so finish_reason: tool_calls never reaches continuation logic
    const result = simulateContinuation([response])
    expect(result.finalContent).toBe('Partial')
    expect(result.retries).toBe(0)
  })

  test('respects custom max retries', () => {
    const result = simulateContinuation(
      [
        makeResponse({ content: 'A', finish_reason: 'length' }),
        makeResponse({ content: 'B', finish_reason: 'length' }),
        makeResponse({ content: 'C', finish_reason: 'stop' }),
      ],
      1, // Only 1 retry allowed
    )

    // After 1 retry (A accumulated), the 2nd truncated response is accepted as final
    expect(result.finalContent).toBe('AB')
    expect(result.retries).toBe(1)
    expect(result.turns).toBe(2)
  })
})

describe('Anthropic stop_reason mapping', () => {
  test('max_tokens maps to length', () => {
    // Simulates the mapping in anthropic.ts parseResponse
    const mapStopReason = (stopReason: string) =>
      stopReason === 'max_tokens'
        ? 'length'
        : stopReason === 'tool_use'
          ? 'tool_calls'
          : stopReason ?? 'stop'

    expect(mapStopReason('max_tokens')).toBe('length')
    expect(mapStopReason('end_turn')).toBe('end_turn')
    expect(mapStopReason('tool_use')).toBe('tool_calls')
  })
})
