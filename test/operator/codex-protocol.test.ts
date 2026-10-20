import { describe, expect, test } from 'bun:test'
import {
  codexEffort,
  codexToolResponse,
  codexTurnParams,
  isStaleThread,
} from '../../src/operator/codex-protocol'

describe('codex wire helpers', () => {
  test('thinking off leaves the model default; other levels pass through as effort', () => {
    expect(codexEffort('off')).toBeUndefined()
    expect(codexEffort('high')).toBe('high')
    expect(codexTurnParams({ threadId: 't', text: 'x', thinking: 'low' }).effort).toBe('low')
  })

  test('a failed result says so, and a note rides after it', () => {
    expect(codexToolResponse({ success: false, output: 'nope' }, 'wrap up')).toEqual({
      contentItems: [
        { type: 'inputText', text: 'nope' },
        { type: 'inputText', text: 'wrap up' },
      ],
      success: false,
    })
  })

  test('an image result that is not a data URL goes back as text', () => {
    expect(
      codexToolResponse({ success: true, output: '/tmp/shot.png', isImage: true }).contentItems,
    ).toEqual([{ type: 'inputText', text: '/tmp/shot.png' }])
  })

  test('only a missing rollout or thread counts as stale', () => {
    expect(isStaleThread('{"message":"no rollout found for thread id abc"}')).toBe(true)
    expect(isStaleThread('thread not found: abc')).toBe(true)
    expect(isStaleThread('Codex exited before completion (code 1)')).toBe(false)
  })
})
