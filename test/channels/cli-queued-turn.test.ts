/**
 * The turn that starts by itself after a turn ends.
 *
 * Messages typed mid-turn are sent as the next turn the moment the current one finishes. That
 * turn used to be echoed as `✦ you <msg>`, the same as the prompt, and could then sit for minutes
 * on compaction under a spinner saying "waiting for model" -- which read as a dead prompt.
 */

import { describe, expect, test } from 'bun:test'
import { createCLIEventHandler, renderDrained } from '../../src/channels/cli-events'
import type { Phase, StatusLine } from '../../src/channels/cli-status'

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const strip = (s: string): string => s.replace(ANSI, '')

describe('renderDrained', () => {
  test('is not the prompt and says what typing does now', () => {
    const out = strip(renderDrained('How do you suggest proceeding?', 1))
    expect(out).not.toContain('✦ you')
    expect(out).toContain('sending queued message')
    expect(out).toContain('How do you suggest proceeding?')
    expect(out).toContain('typing now queues')
  })

  test('counts several messages and shows each line', () => {
    const out = strip(renderDrained('first\nsecond', 2))
    expect(out).toContain('sending 2 queued messages')
    expect(out).toContain('│ first')
    expect(out).toContain('│ second')
  })
})

describe('compacting phase', () => {
  test('the CLI handler puts the phase on the status line', () => {
    const phases: Phase[] = []
    const status: StatusLine = { set: (p) => phases.push(p), clear() {}, stop() {} }
    const { handler } = createCLIEventHandler(false, status)
    handler.onPhase?.('compacting')
    handler.onPhase?.('waiting')
    expect(phases).toEqual(['compacting', 'waiting'])
  })
})
