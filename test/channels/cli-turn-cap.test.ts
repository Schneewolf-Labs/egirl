/**
 * A run that stops at its turn cap says how to get past it.
 *
 * The cap was invisible until it hit, and /maxturns, /auto and /continue were not things anyone
 * guesses -- the cap's own message is the place to name them.
 */

import { describe, expect, test } from 'bun:test'
import { renderTurnCap } from '../../src/channels/cli-events'

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const strip = (s: string): string => s.replace(ANSI, '')

describe('renderTurnCap', () => {
  test('in ask mode, names every way past the cap', () => {
    const out = strip(renderTurnCap(10, false))
    expect(out).toContain('stopped at the 10-turn cap')
    expect(out).toContain('/continue')
    expect(out).toContain('/maxturns 30')
    expect(out).toContain('/auto')
  })

  test('never suggests a cap /maxturns would refuse', () => {
    expect(strip(renderTurnCap(400, false))).toContain('/maxturns 500')
  })

  test('in auto mode, says it is carrying on and how to stop it', () => {
    const out = strip(renderTurnCap(10, true))
    expect(out).toContain('continuing')
    expect(out).toContain('esc interrupts')
    expect(out).not.toContain('/continue keeps going')
  })
})
