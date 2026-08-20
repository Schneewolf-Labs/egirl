/**
 * Live reasoning display in the CLI.
 *
 * Reasoning now arrives twice: token by token while the model deliberates, and again as an
 * assembled block once generation finishes. Showing both would print the model's entire
 * thought process a second time -- roughly 1200 tokens of it on a hard question -- directly
 * above the answer. These tests pin down which one wins.
 */

import { describe, expect, test } from 'bun:test'
import { createCLIEventHandler } from '../../src/channels/cli-events'
import { setTheme } from '../../src/ui/theme'

setTheme('vapor')

// Built rather than written as a literal: an escape character inside a regex literal trips
// biome's noControlCharactersInRegex.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const strip = (s: string): string => s.replace(ANSI, '')

/** Capture everything the handler writes to stdout during `run`. */
function captureStdout(run: () => void): string {
  const chunks: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  // @ts-expect-error test double
  process.stdout.write = (c: string) => {
    chunks.push(String(c))
    return true
  }
  try {
    run()
  } finally {
    process.stdout.write = orig
  }
  return chunks.join('')
}

describe('live reasoning in the CLI', () => {
  test('reasoning tokens print as they arrive', () => {
    const { handler } = createCLIEventHandler(true)
    const out = captureStdout(() => {
      handler.onThinkingToken?.('weigh')
      handler.onThinkingToken?.('ing it')
    })
    expect(strip(out)).toContain('[thinking]')
    expect(strip(out)).toContain('weighing it')
  })

  test('the assembled block is suppressed once it has been streamed', () => {
    // The regression this guards: reasoning shown live, then dumped again in full.
    const { handler } = createCLIEventHandler(true)
    const out = captureStdout(() => {
      handler.onThinkingToken?.('weighing it')
      handler.onThinking?.('weighing it')
    })
    const occurrences = strip(out).split('weighing it').length - 1
    expect(occurrences).toBe(1)
  })

  test('the assembled block still prints when nothing was streamed', () => {
    // Providers that deliver reasoning only at the end must keep working.
    const { handler } = createCLIEventHandler(true)
    const out = captureStdout(() => handler.onThinking?.('after the fact'))
    expect(strip(out)).toContain('after the fact')
  })

  test('reasoning stays hidden when thinking display is off', () => {
    const { handler } = createCLIEventHandler(false)
    const out = captureStdout(() => {
      handler.onThinkingToken?.('private deliberation')
      handler.onThinking?.('private deliberation')
    })
    expect(out).toBe('')
  })

  test('the answer is separated from the reasoning above it', () => {
    // Without a break the first content token continues the last line of thought, and the
    // answer is indistinguishable from the deliberation that produced it.
    const { handler } = createCLIEventHandler(true)
    const out = captureStdout(() => {
      handler.onThinkingToken?.('...so 391')
      handler.onToken?.('391')
    })
    const plain = strip(out)
    expect(plain.indexOf('egirl>')).toBeGreaterThan(plain.indexOf('...so 391'))
    expect(plain).toContain('\n\negirl>')
  })
})
