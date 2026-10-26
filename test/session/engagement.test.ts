/**
 * Engagement policy.
 *
 * The deterministic replacement for the "should I butt in?" relevance check: whole-word wake
 * detection, an addressed-always-wins rule, and a per-conversation window that lets a reply
 * carry the next few messages without a fresh wake word. Time is injected so the window is
 * tested exactly, without waiting.
 */

import { describe, expect, test } from 'bun:test'
import {
  containsWakeWord,
  type EngagementConfig,
  EngagementTracker,
} from '../../src/session/engagement'

const base: EngagementConfig = {
  wakeWords: ['juno'],
  conversationWindowMs: 120_000,
  requireWake: true,
}

const C = 'conv-1'

describe('containsWakeWord', () => {
  test('matches case-insensitively as a whole word', () => {
    expect(containsWakeWord('hey Juno, got a sec?', ['juno'])).toBe(true)
    expect(containsWakeWord('JUNO!', ['juno'])).toBe(true)
    expect(containsWakeWord('ok juno', ['juno'])).toBe(true)
  })

  test('does not match a wake word embedded in a larger word', () => {
    expect(containsWakeWord('junonium is an element', ['juno'])).toBe(false)
    expect(containsWakeWord('disjunction', ['juno'])).toBe(false)
  })

  test('substring mode matches inside a word when whole-word is off', () => {
    expect(containsWakeWord('junonium', ['juno'], false)).toBe(true)
  })

  test('empty wake list or empty text never matches', () => {
    expect(containsWakeWord('juno', [])).toBe(false)
    expect(containsWakeWord('', ['juno'])).toBe(false)
  })

  test('honors multiple wake words and ignores blanks', () => {
    expect(containsWakeWord('hey eisvogel', ['juno', 'eisvogel'])).toBe(true)
    expect(containsWakeWord('nothing here', ['  ', ''])).toBe(false)
  })
})

describe('EngagementTracker — wake gating', () => {
  test('a wake word engages', () => {
    const t = new EngagementTracker(base)
    expect(t.consider({ conversationId: C, text: 'juno, status?', at: 0 })).toEqual({
      engage: true,
      reason: 'wake',
    })
  })

  test('no wake word, not engaged, requireWake → idle', () => {
    const t = new EngagementTracker(base)
    expect(t.consider({ conversationId: C, text: 'just thinking out loud', at: 0 })).toEqual({
      engage: false,
      reason: 'idle',
    })
  })

  test('addressed always engages, even with no wake word', () => {
    const t = new EngagementTracker(base)
    expect(t.consider({ conversationId: C, text: 'no name here', addressed: true, at: 0 })).toEqual(
      { engage: true, reason: 'addressed' },
    )
  })
})

describe('EngagementTracker — conversation window', () => {
  test('messages within the window after engaging continue without a wake word', () => {
    const t = new EngagementTracker(base)
    expect(t.consider({ conversationId: C, text: 'juno hi', at: 0 }).reason).toBe('wake')
    // 10s later, no wake word — still inside the 120s window.
    expect(t.consider({ conversationId: C, text: 'and one more thing', at: 10_000 })).toEqual({
      engage: true,
      reason: 'window',
    })
  })

  test('each engagement extends the window from that moment', () => {
    const t = new EngagementTracker(base)
    t.consider({ conversationId: C, text: 'juno', at: 0 })
    // keep talking just under the window each time; total span exceeds one window length
    t.consider({ conversationId: C, text: 'more', at: 100_000 })
    expect(t.consider({ conversationId: C, text: 'more still', at: 200_000 }).reason).toBe('window')
  })

  test('once the window lapses, a wake word is required again', () => {
    const t = new EngagementTracker(base)
    t.consider({ conversationId: C, text: 'juno', at: 0 })
    expect(t.consider({ conversationId: C, text: 'anyone?', at: 120_001 })).toEqual({
      engage: false,
      reason: 'idle',
    })
  })

  test('noteReply opens the window so follow-ups carry on', () => {
    const t = new EngagementTracker(base)
    expect(t.isEngaged(C, 0)).toBe(false)
    t.noteReply(C, 0)
    expect(t.isEngaged(C, 60_000)).toBe(true)
    expect(t.consider({ conversationId: C, text: 'thanks, and…', at: 60_000 }).reason).toBe(
      'window',
    )
  })

  test('windows are isolated per conversation', () => {
    const t = new EngagementTracker(base)
    t.consider({ conversationId: 'a', text: 'juno', at: 0 })
    expect(t.consider({ conversationId: 'b', text: 'no wake here', at: 10 })).toEqual({
      engage: false,
      reason: 'idle',
    })
  })

  test('reset closes the window', () => {
    const t = new EngagementTracker(base)
    t.consider({ conversationId: C, text: 'juno', at: 0 })
    t.reset(C)
    expect(t.isEngaged(C, 1)).toBe(false)
  })
})

describe('EngagementTracker — solo channel (requireWake = false)', () => {
  const solo = new EngagementTracker({ ...base, requireWake: false })

  test('engages on any message with reason "open"', () => {
    expect(solo.consider({ conversationId: C, text: 'whatever', at: 0 })).toEqual({
      engage: true,
      reason: 'open',
    })
  })

  test('a wake word still reports as "wake", not "open"', () => {
    const t = new EngagementTracker({ ...base, requireWake: false })
    expect(t.consider({ conversationId: C, text: 'juno!', at: 0 }).reason).toBe('wake')
  })
})

describe('EngagementTracker — no window (conversationWindowMs = 0)', () => {
  test('every turn must be addressed or named; nothing carries over', () => {
    const t = new EngagementTracker({ ...base, conversationWindowMs: 0 })
    expect(t.consider({ conversationId: C, text: 'juno', at: 0 }).reason).toBe('wake')
    expect(t.consider({ conversationId: C, text: 'follow up', at: 1 })).toEqual({
      engage: false,
      reason: 'idle',
    })
  })
})
