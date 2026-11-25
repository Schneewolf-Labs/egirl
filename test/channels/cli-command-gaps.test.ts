/**
 * CLI command gaps: reasoning toggles that did nothing, tool arguments printed whole, and skill
 * commands that never completed.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { complete } from '../../src/channels/cli-complete'
import { formatArgs } from '../../src/channels/cli-events'
import type { CLIInput } from '../../src/channels/cli-input'
import { runTurns } from '../../src/channels/cli-turn'
import { createWaitHistory } from '../../src/channels/cli-wait'
import type { Operator } from '../../src/operator/types'
import { SessionController } from '../../src/session/controller'

describe('formatArgs', () => {
  test('a file body collapses to its line count; short values stay inline', () => {
    const body = Array.from({ length: 312 }, (_, i) => `line ${i}`).join('\n')
    expect(formatArgs({ path: 'src/bxgen.py', content: body })).toBe(
      'path: src/bxgen.py, content: ‹312 lines›',
    )
  })

  test('long single-line values are cut, and many arguments go one per line', () => {
    const out = formatArgs({ command: `echo ${'x'.repeat(200)}`, timeout: 600000, cwd: '/tmp' })
    expect(out.split('\n')).toHaveLength(3)
    expect(out).toContain('…')
    expect(out).toContain('timeout: 600000')
  })
})

describe('skill commands complete', () => {
  test('alongside the built-in ones', () => {
    expect(
      complete(
        '/dr',
        () => [],
        () => ['draw'],
      ).candidates,
    ).toEqual(['/draw'])
  })
})

describe('/reasoning reaches the renderer', () => {
  const realWrite = process.stdout.write.bind(process.stdout)
  let written = ''
  afterEach(() => {
    process.stdout.write = realWrite
  })

  const input: CLIInput = {
    isInteractive: false,
    setPrompt() {},
    setStatus() {},
    notice() {},
    suggest() {},
    ask: async () => '',
    close() {},
  }
  const agent = {
    run: async (_t: string, opts: { events: { onThinkingToken?: (t: string) => void } }) => {
      opts.events.onThinkingToken?.('SECRET-REASONING')
      return { content: 'done', provider: 'stub' }
    },
    contextStatus: async () => ({ contextLength: 100, totalUsed: 1, utilization: 0 }),
  } as unknown as Operator

  async function reasoningShown(showReasoning: boolean): Promise<boolean> {
    written = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written += String(chunk)
      return true
    }) as typeof process.stdout.write
    const log = console.log
    console.log = () => {}
    try {
      const session = new SessionController({ showReasoning })
      await runTurns('go', { agent, session, input, waits: createWaitHistory() })
    } finally {
      console.log = log
    }
    return written.includes('SECRET-REASONING')
  }

  test('the session setting decides whether reasoning prints', async () => {
    expect(await reasoningShown(true)).toBe(true)
    expect(await reasoningShown(false)).toBe(false)
  })
})
