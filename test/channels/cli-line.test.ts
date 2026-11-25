/**
 * The live input line is one terminal row, always: a long line scrolls sideways around the
 * cursor, and an overlong prompt is cut, because a wrapped line cannot be erased with one clear.
 */

import { describe, expect, test } from 'bun:test'
import { fitLine, truncateVisible, visibleWidth } from '../../src/channels/cli-line'

const ESC = String.fromCharCode(27)

describe('visibleWidth', () => {
  test('ignores colour codes', () => {
    expect(visibleWidth(`${ESC}[38;5;135m✦ you${ESC}[0m `)).toBe(6)
  })
})

describe('truncateVisible', () => {
  test('leaves text that fits alone', () => {
    expect(truncateVisible('short', 10)).toBe('short')
  })

  test('cuts to the width, keeps the codes, and resets colour', () => {
    const cut = truncateVisible(`${ESC}[2mwaiting for model 59s${ESC}[0m`, 8)
    expect(visibleWidth(cut)).toBe(8)
    expect(cut.startsWith(`${ESC}[2m`)).toBe(true)
    expect(cut.endsWith(`…${ESC}[0m`)).toBe(true)
  })
})

describe('fitLine', () => {
  test('a line that fits is shown whole, cursor counted back from its end', () => {
    expect(fitLine('hello', 5, 20)).toEqual({ shown: 'hello', back: 0 })
    expect(fitLine('hello', 2, 20)).toEqual({ shown: 'hello', back: 3 })
  })

  test('a long line scrolls to keep the cursor in view', () => {
    const line = 'abcdefghijklmnopqrstuvwxyz'
    const atEnd = fitLine(line, line.length, 10)
    expect(atEnd.shown).toHaveLength(10)
    expect(atEnd.shown.endsWith('z')).toBe(true)
    const atStart = fitLine(line, 0, 10)
    expect(atStart).toEqual({ shown: 'abcdefghij', back: 10 })
  })
})
