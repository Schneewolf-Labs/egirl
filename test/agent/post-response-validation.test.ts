import { describe, expect, test } from 'bun:test'
import type { ValidationResult } from '../../src/agent/events'

/**
 * Tests for post-response validation hook logic.
 *
 * Simulates the validation loop from AgentLoop.doRun() to verify
 * correct retry behavior without full agent infrastructure.
 */

interface SimResponse {
  content: string
  finish_reason: 'stop' | 'length'
}

function simulateValidation(
  responses: SimResponse[],
  validator: (content: string) => ValidationResult,
): { finalContent: string; validationRetried: boolean; turns: number } {
  let validationRetried = false
  let turns = 0
  let responseIdx = 0

  while (responseIdx < responses.length) {
    const response = responses[responseIdx]!
    turns++
    responseIdx++

    const finalContent = response.content

    // Post-response validation — only retry once
    if (!validationRetried) {
      const validation = validator(finalContent)
      if (!validation.valid) {
        validationRetried = true
        continue // retry with next response
      }
    }

    return { finalContent, validationRetried, turns }
  }

  // Exhausted responses
  return {
    finalContent: responses[responses.length - 1]?.content ?? '',
    validationRetried,
    turns,
  }
}

describe('post-response validation', () => {
  test('passes validation on first try', () => {
    const result = simulateValidation(
      [{ content: 'Good response', finish_reason: 'stop' }],
      () => ({ valid: true }),
    )

    expect(result.finalContent).toBe('Good response')
    expect(result.validationRetried).toBe(false)
    expect(result.turns).toBe(1)
  })

  test('retries once when validation fails', () => {
    const result = simulateValidation(
      [
        { content: 'Bad response with TODO placeholder', finish_reason: 'stop' },
        { content: 'Good response without placeholders', finish_reason: 'stop' },
      ],
      (content) => {
        if (content.includes('TODO')) {
          return { valid: false, feedback: 'Response contains TODO placeholder' }
        }
        return { valid: true }
      },
    )

    expect(result.finalContent).toBe('Good response without placeholders')
    expect(result.validationRetried).toBe(true)
    expect(result.turns).toBe(2)
  })

  test('only retries once to prevent infinite loops', () => {
    const result = simulateValidation(
      [
        { content: 'Bad response 1', finish_reason: 'stop' },
        { content: 'Bad response 2', finish_reason: 'stop' },
        { content: 'Bad response 3', finish_reason: 'stop' },
      ],
      () => ({ valid: false, feedback: 'Always fails' }),
    )

    // Second response is accepted despite failing validation (retry limit)
    expect(result.finalContent).toBe('Bad response 2')
    expect(result.validationRetried).toBe(true)
    expect(result.turns).toBe(2)
  })

  test('validator can check for specific patterns', () => {
    const noPlaceholders = (content: string): ValidationResult => {
      const placeholders = ['TODO', 'FIXME', '...', 'placeholder']
      for (const p of placeholders) {
        if (content.includes(p)) {
          return { valid: false, feedback: `Response contains "${p}"` }
        }
      }
      return { valid: true }
    }

    // First response has placeholder
    const result1 = simulateValidation(
      [
        { content: 'function foo() { /* TODO */ }', finish_reason: 'stop' },
        { content: 'function foo() { return 42; }', finish_reason: 'stop' },
      ],
      noPlaceholders,
    )
    expect(result1.finalContent).toBe('function foo() { return 42; }')
    expect(result1.validationRetried).toBe(true)

    // First response is clean
    const result2 = simulateValidation(
      [{ content: 'function foo() { return 42; }', finish_reason: 'stop' }],
      noPlaceholders,
    )
    expect(result2.finalContent).toBe('function foo() { return 42; }')
    expect(result2.validationRetried).toBe(false)
  })

  test('validator can check minimum length', () => {
    const minLength = (content: string): ValidationResult => {
      if (content.length < 20) {
        return { valid: false, feedback: 'Response is too short, provide more detail' }
      }
      return { valid: true }
    }

    const result = simulateValidation(
      [
        { content: 'Yes.', finish_reason: 'stop' },
        { content: 'Here is a more detailed response to your question.', finish_reason: 'stop' },
      ],
      minLength,
    )

    expect(result.finalContent).toBe('Here is a more detailed response to your question.')
    expect(result.validationRetried).toBe(true)
  })
})

describe('ValidationResult type', () => {
  test('valid result has no feedback', () => {
    const result: ValidationResult = { valid: true }
    expect(result.valid).toBe(true)
    expect(result.feedback).toBeUndefined()
  })

  test('invalid result has feedback', () => {
    const result: ValidationResult = {
      valid: false,
      feedback: 'Missing required section',
    }
    expect(result.valid).toBe(false)
    expect(result.feedback).toBe('Missing required section')
  })

  test('invalid result without feedback uses default', () => {
    const result: ValidationResult = { valid: false }
    const feedback =
      result.feedback ?? 'Your previous response did not pass validation. Please try again.'
    expect(feedback).toContain('validation')
  })
})
