/**
 * Session control.
 *
 * These are the rules that decide what happens to input arriving at an awkward moment, and to a
 * run someone changed their mind about. Both surfaces read them, so a disagreement here shows up
 * as a terminal and a browser behaving differently on the same session -- which is the exact
 * failure putting this in one place is meant to prevent.
 */

import { describe, expect, test } from 'bun:test'
import { SessionController } from '../../src/session/controller'

describe('queue', () => {
  test('holds messages typed during a turn', () => {
    const s = new SessionController()
    s.enqueue('first')
    s.enqueue('second')
    expect(s.peek()).toHaveLength(2)
  })

  test('drains as one message, not several turns', () => {
    // Three thoughts typed while it was thinking are one intent. Delivered separately the agent
    // answers the first and rediscovers the rest afterwards.
    const s = new SessionController()
    s.enqueue('a')
    s.enqueue('b')
    expect(s.drain()).toBe('a\nb')
    expect(s.peek()).toHaveLength(0)
  })

  test('drains to undefined when empty, so callers can tell nothing was waiting', () => {
    expect(new SessionController().drain()).toBeUndefined()
  })

  test('ignores whitespace-only input', () => {
    const s = new SessionController()
    s.enqueue('   ')
    s.enqueue('\n')
    expect(s.peek()).toHaveLength(0)
  })
})

describe('interrupt', () => {
  test('aborts a running turn', () => {
    const s = new SessionController()
    const signal = s.begin()
    expect(signal.aborted).toBe(false)
    expect(s.interrupt()).toBe(true)
    expect(signal.aborted).toBe(true)
  })

  test('reports false when nothing is running', () => {
    // A stray Esc at the prompt must not read as a successful interrupt, or the UI claims to
    // have stopped something that was never going.
    expect(new SessionController().interrupt()).toBe(false)
  })

  test('each turn gets a fresh signal', () => {
    const s = new SessionController()
    const first = s.begin()
    s.interrupt()
    s.end()
    const second = s.begin()
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
  })

  test('interrupted state resets on the next turn', () => {
    const s = new SessionController()
    s.begin()
    s.interrupt()
    expect(s.wasInterrupted).toBe(true)
    s.end()
    s.begin()
    expect(s.wasInterrupted).toBe(false)
  })
})

describe('mode', () => {
  test('defaults to asking before running past the turn cap', () => {
    expect(new SessionController().shouldContinuePastCap()).toBe(false)
  })

  test('auto continues without asking', () => {
    const s = new SessionController()
    s.toggleMode()
    expect(s.get().mode).toBe('auto')
    expect(s.shouldContinuePastCap()).toBe(true)
  })

  test('toggles back', () => {
    const s = new SessionController()
    s.toggleMode()
    s.toggleMode()
    expect(s.get().mode).toBe('ask')
  })
})
