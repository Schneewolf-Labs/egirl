/**
 * Status line and context bar.
 *
 * The spinner itself is animation and not worth asserting. What matters: it must not write to a
 * pipe (a spinner interleaved into `-m … | jq` output is worse than none), it must not restart
 * its clock on a repeated phase, and the context bar must agree with `/context` about when
 * things are getting tight -- two indicators disagreeing about the same number is worse than
 * having one.
 */

import { describe, expect, test } from 'bun:test'
import { contextBar, createStatusLine } from '../../src/channels/cli-status'
import { setTheme } from '../../src/ui/theme'

setTheme('vapor')

// Built rather than written as a literal: an escape character inside a regex literal trips
// biome's noControlCharactersInRegex.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const strip = (s: string): string => s.replace(ANSI, '')

describe('createStatusLine', () => {
  test('writes nothing when output is not a TTY', () => {
    // Redirected output means a log file or a pipe; control codes there are corruption.
    const chunks: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    // @ts-expect-error test double
    process.stderr.write = (c: string) => {
      chunks.push(String(c))
      return true
    }
    try {
      const s = createStatusLine({ enabled: false })
      s.set('thinking')
      s.set('writing')
      s.stop()
    } finally {
      process.stderr.write = orig
    }
    expect(chunks.join('')).toBe('')
  })

  test('clear and stop are safe before anything was painted', () => {
    const s = createStatusLine({ enabled: false })
    expect(() => {
      s.clear()
      s.stop()
      s.stop()
    }).not.toThrow()
  })

  test('going idle stops cleanly', () => {
    const s = createStatusLine({ enabled: false })
    s.set('tool', 'read_file')
    s.set('idle')
    expect(() => s.stop()).not.toThrow()
  })
})

describe('contextBar', () => {
  test('reports the percentage', () => {
    expect(strip(contextBar(0.42, 42000, 100000))).toContain('42%')
  })

  test('fills proportionally', () => {
    expect(strip(contextBar(0, 0, 1000))).toContain('░░░░░░░░░░░░')
    expect(strip(contextBar(1, 1000, 1000))).toContain('████████████')
  })

  test('abbreviates token counts so the line stays short', () => {
    expect(strip(contextBar(0.5, 65536, 131072))).toContain('66k/131k')
    expect(strip(contextBar(0.1, 900, 9000))).toContain('900/9.0k')
  })

  test('never renders a bar wider than its width, even past 100%', () => {
    // Utilization can exceed 1 briefly before compaction runs; the bar must not wrap the line.
    const bar = strip(contextBar(1.4, 14000, 10000))
    const filled = (bar.match(/█/g) ?? []).length
    const empty = (bar.match(/░/g) ?? []).length
    expect(filled + empty).toBe(12)
  })

  test('handles zero budget without dividing into nonsense', () => {
    expect(() => contextBar(0, 0, 0)).not.toThrow()
  })
})
