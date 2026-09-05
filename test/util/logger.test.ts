import { describe, expect, test } from 'bun:test'

/**
 * What actually reaches the terminal.
 *
 * The tests above cover `getEntries`, which stores `data` untouched — so they pass whether or not
 * the rendering works. The defect lived entirely in the rendering step: `JSON.stringify` drops
 * `message`, `name` and `stack` because all three are non-enumerable on Error, so 46 call sites
 * that pass an error were printing `{}` where the reason should be. Only the emitted line shows
 * it, so these capture stderr.
 */
describe('Logger error rendering', () => {
  let log: typeof import('../../src/util/logger')['log']

  async function capture(emit: () => void): Promise<string> {
    const mod = await import('../../src/util/logger')
    log = mod.log
    log.setLevel('debug')

    const original = console.error
    const lines: string[] = []
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      emit()
    } finally {
      console.error = original
    }
    return lines.join('\n')
  }

  test('an Error renders its message instead of {}', async () => {
    const output = await capture(() => {
      log.error('cat', 'Failed to load config:', new Error('unexpected token at line 12'))
    })
    expect(output).toContain('unexpected token at line 12')
    expect(output).not.toContain('{}')
  })

  test('the cause chain is followed, not just the outermost error', async () => {
    // The outermost error is usually the least informative one in the chain.
    const root = new Error('ENOENT: no such file')
    const wrapped = new Error('could not parse egirl.toml', { cause: root })
    const output = await capture(() => log.error('cat', 'boom', wrapped))
    expect(output).toContain('could not parse egirl.toml')
    expect(output).toContain('ENOENT: no such file')
  })

  test('an Error nested in a payload keeps its message too', async () => {
    const output = await capture(() =>
      log.warn('cat', 'tool failed', { tool: 'read_file', error: new Error('permission denied') }),
    )
    expect(output).toContain('permission denied')
    expect(output).toContain('read_file')
  })

  test('a circular payload does not throw out of the logger', async () => {
    // JSON.stringify throws on a cycle, and a logger that throws takes down the call site that
    // was only trying to report a problem.
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    const output = await capture(() => log.info('cat', 'state', circular))
    expect(output).toContain('state')
  })

  test('plain objects and strings are unchanged', async () => {
    const object = await capture(() => log.info('cat', 'msg', { a: 1 }))
    expect(object).toContain('"a": 1')
    const text = await capture(() => log.info('cat', 'msg', 'raw string'))
    expect(text).toContain('raw string')
  })

  test('a non-Error thrown value still reports something', async () => {
    const output = await capture(() => log.error('cat', 'threw', 'just a string'))
    expect(output).toContain('just a string')
  })
})
