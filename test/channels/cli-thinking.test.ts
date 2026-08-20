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

/** A StatusLine that records phase changes instead of animating. */
function fakeStatus(): { phases: string[]; line: Parameters<typeof createCLIEventHandler>[1] } {
  const phases: string[] = []
  return {
    phases,
    line: {
      set: (phase: string) => phases.push(phase),
      clear: () => {},
      stop: () => {},
    } as NonNullable<Parameters<typeof createCLIEventHandler>[1]>,
  }
}

describe('spinner and streamed text never compete', () => {
  // The spinner repaints on stderr; streamed text goes to stdout. In a terminal they share a
  // screen, so an animation running while text streams would overwrite the output. Whenever
  // there is text to watch, the spinner has to be off.
  test('reasoning shown: the spinner stands down so text can stream', () => {
    const { phases, line } = fakeStatus()
    const { handler } = createCLIEventHandler(true, line)
    captureStdout(() => handler.onThinkingToken?.('deliberating'))
    expect(phases).toEqual(['idle'])
  })

  test('reasoning hidden: the spinner is the only feedback, so it runs', () => {
    const { phases, line } = fakeStatus()
    const { handler } = createCLIEventHandler(false, line)
    captureStdout(() => handler.onThinkingToken?.('deliberating'))
    expect(phases).toEqual(['thinking'])
  })

  test('the answer streaming in stops the spinner', () => {
    const { phases, line } = fakeStatus()
    const { handler } = createCLIEventHandler(false, line)
    captureStdout(() => handler.onToken?.('answer'))
    expect(phases).toContain('idle')
  })

  test('a running tool is named, and finishing it returns to waiting', () => {
    // Nothing prints while a tool runs, so this is the one phase with no text of its own.
    const { phases, line } = fakeStatus()
    const { handler } = createCLIEventHandler(false, line)
    captureStdout(() => {
      handler.onToolCallStart?.([{ id: '1', name: 'read_file', arguments: {} }])
      handler.onToolCallComplete?.('1', 'read_file', { success: true, output: 'ok' })
    })
    expect(phases).toEqual(['tool', 'waiting'])
  })
})

describe('live reasoning in the CLI', () => {
  test('reasoning tokens print as they arrive', () => {
    const { handler } = createCLIEventHandler(true)
    const out = captureStdout(() => {
      handler.onThinkingToken?.('weigh')
      handler.onThinkingToken?.('ing it')
    })
    expect(strip(out)).toContain('✧ thinking')
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
    expect(plain.indexOf('✦ egirl')).toBeGreaterThan(plain.indexOf('...so 391'))
    expect(plain).toContain('\n\n✦ egirl')
  })
})
