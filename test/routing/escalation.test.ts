import { describe, expect, test } from 'bun:test'
import type { ChatResponse } from '../../src/providers/types'
import { analyzeResponseForEscalation, shouldRetryWithRemote } from '../../src/routing/escalation'

function makeResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content: 'A normal response with enough text to be substantial.',
    usage: { input_tokens: 100, output_tokens: 50 },
    model: 'test-model',
    ...overrides,
  }
}

describe('analyzeResponseForEscalation', () => {
  test('escalates when confidence is below threshold', () => {
    const response = makeResponse({ confidence: 0.2 })
    const result = analyzeResponseForEscalation(response, 0.4)
    expect(result.shouldEscalate).toBe(true)
    expect(result.reason).toBe('low_confidence')
    expect(result.confidence).toBe(0.2)
  })

  test('does not escalate when confidence is above threshold', () => {
    const response = makeResponse({ confidence: 0.8 })
    const result = analyzeResponseForEscalation(response, 0.4)
    expect(result.shouldEscalate).toBe(false)
  })

  test('detects uncertainty patterns', () => {
    const patterns = [
      "I'm not sure about this",
      "I don't know the answer",
      'I cannot help with that',
      "I'm unable to determine",
      "I'm having trouble parsing",
    ]

    for (const content of patterns) {
      const response = makeResponse({ content })
      const result = analyzeResponseForEscalation(response, 0.4)
      expect(result.shouldEscalate).toBe(true)
      expect(result.reason).toBe('uncertainty_detected')
      expect(result.confidence).toBe(0.3)
    }
  })

  test('detects error patterns in prose (not inside code blocks)', () => {
    const response = makeResponse({
      content: 'The error: something failed in the system.',
    })
    const result = analyzeResponseForEscalation(response, 0.4)
    expect(result.shouldEscalate).toBe(true)
    expect(result.reason).toBe('potential_code_errors')
    expect(result.confidence).toBe(0.4)
  })

  test('does not escalate for error patterns inside code blocks', () => {
    const response = makeResponse({
      content: 'Here is the output:\n```\nerror: something failed\n```\nThis looks correct.',
    })
    const result = analyzeResponseForEscalation(response, 0.4)
    // Error is inside a code block, should not trigger escalation
    expect(result.reason).not.toBe('potential_code_errors')
  })

  test('escalates for very short responses', () => {
    const response = makeResponse({ content: 'Yes.' })
    const result = analyzeResponseForEscalation(response, 0.4)
    expect(result.shouldEscalate).toBe(true)
    expect(result.reason).toBe('insufficient_response')
    expect(result.confidence).toBe(0.5)
  })

  test('does not escalate short response if tool_calls present', () => {
    const response = makeResponse({
      content: 'Ok',
      tool_calls: [{ id: 'call_0', name: 'read_file', arguments: { path: 'test.txt' } }],
    })
    const result = analyzeResponseForEscalation(response, 0.4)
    expect(result.shouldEscalate).toBe(false)
  })

  test('returns no escalation for normal response', () => {
    const response = makeResponse()
    const result = analyzeResponseForEscalation(response, 0.4)
    expect(result.shouldEscalate).toBe(false)
    expect(result.confidence).toBe(0.7)
  })

  test('uses provided confidence when no escalation', () => {
    const response = makeResponse({ confidence: 0.9 })
    const result = analyzeResponseForEscalation(response, 0.4)
    expect(result.shouldEscalate).toBe(false)
    expect(result.confidence).toBe(0.9)
  })
})

describe('shouldRetryWithRemote', () => {
  test('returns true when response should escalate', () => {
    const response = makeResponse({ confidence: 0.1 })
    expect(shouldRetryWithRemote(response, 0.4)).toBe(true)
  })

  test('returns false when response is acceptable', () => {
    const response = makeResponse({ confidence: 0.8 })
    expect(shouldRetryWithRemote(response, 0.4)).toBe(false)
  })

  test('returns true for uncertain responses', () => {
    const response = makeResponse({ content: "I'm not sure how to do this" })
    expect(shouldRetryWithRemote(response, 0.4)).toBe(true)
  })
})
