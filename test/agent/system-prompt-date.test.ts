import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystemPrompt, formatCurrentDate } from '../../src/agent/context'
import { makeConfig } from './helpers'

describe('current date in the system prompt', () => {
  const now = new Date(2026, 9, 6, 9, 30) // local time, month is 0-based

  test('formats the local date with the weekday', () => {
    expect(formatCurrentDate(now)).toBe('2026-10-06 (Tuesday)')
  })

  test('is in the volatile tail, after the cached stable prefix', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'egirl-date-'))
    writeFileSync(join(workspace, 'IDENTITY.md'), '# Identity\n\nTest agent.')
    const parts = buildSystemPrompt(makeConfig(workspace), { now })
    expect(parts.volatile).toContain('Current date: 2026-10-06 (Tuesday)')
    expect(parts.stable).not.toContain('Current date')
    expect(parts.full.endsWith('Current date: 2026-10-06 (Tuesday)')).toBe(true)
  })

  test('the minimal fallback prompt also carries the date', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'egirl-date-empty-'))
    const parts = buildSystemPrompt(makeConfig(workspace), { now })
    expect(parts.full).toContain('Current date: 2026-10-06 (Tuesday)')
  })
})
