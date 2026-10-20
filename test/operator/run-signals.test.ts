import { describe, expect, test } from 'bun:test'
import { createRunSignals, noteResult, wrapupNote } from '../../src/operator/run-signals'
import type { Tool } from '../../src/tools/types'

const MIN = 60_000

describe('noteResult', () => {
  test('flags awaiting input and keeps the first end-run reply', () => {
    const s = createRunSignals()
    expect(noteResult(s, { success: true, output: 'x' })).toBe(false)
    expect(noteResult(s, { success: false, output: 'x', awaitingInput: true })).toBe(false)
    expect(s.awaitingInput).toBe(true)
    expect(noteResult(s, { success: true, output: '', endRun: { content: 'first' } })).toBe(true)
    expect(noteResult(s, { success: true, output: '', endRun: { content: 'second' } })).toBe(false)
    expect(s.ended).toBe('first')
  })
})

describe('wrapupNote', () => {
  const tools = new Map<string, Tool>([['request_extension', {} as Tool]])

  test('nothing without a deadline or before the margin', () => {
    const s = createRunSignals()
    expect(wrapupNote(s, {}, 0)).toBeUndefined()
    expect(wrapupNote(s, { deadline: 20 * MIN, wrapupMarginMs: 5 * MIN }, 0)).toBeUndefined()
  })

  test('once inside the margin, naming the run tools that exist', () => {
    const s = createRunSignals()
    const opts = { deadline: 20 * MIN, wrapupMarginMs: 5 * MIN, extraTools: tools }
    const note = wrapupNote(s, opts, 16 * MIN)
    expect(note).toContain('request_extension')
    expect(note).not.toContain('end_task')
    expect(wrapupNote(s, opts, 17 * MIN)).toBeUndefined()
  })

  test('an extension that moves the deadline out re-arms it', () => {
    const s = createRunSignals()
    let deadline = 20 * MIN
    const opts = { deadline: () => deadline, wrapupMarginMs: 5 * MIN }
    expect(wrapupNote(s, opts, 16 * MIN)).toBeDefined()
    deadline = 40 * MIN
    expect(wrapupNote(s, opts, 17 * MIN)).toBeUndefined()
    expect(wrapupNote(s, opts, 36 * MIN)).toBeDefined()
  })
})
