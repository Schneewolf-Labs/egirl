import { beforeEach, describe, expect, test } from 'bun:test'

// We need a fresh Logger instance per test, so import the class indirectly
// The module exports a singleton `log`, so we'll test through it after resetting
// Since Logger is not exported, we test through the singleton's public API

describe('Logger', () => {
  // The logger is a singleton. We use getEntries to verify behavior.
  // We need to import fresh each time or rely on the singleton.

  let log: typeof import('../../src/util/logger')['log']

  beforeEach(async () => {
    // Re-import to get the singleton (state carries over, but we can filter by category)
    const mod = await import('../../src/util/logger')
    log = mod.log
    // Set to debug level so all messages are captured
    log.setLevel('debug')
  })

  test('logs messages at each level', () => {
    const category = `test-levels-${Date.now()}`

    log.debug(category, 'debug message')
    log.info(category, 'info message')
    log.warn(category, 'warn message')
    log.error(category, 'error message')

    const entries = log.getEntries({ category })

    expect(entries.length).toBe(4)
    expect(entries[0]?.level).toBe('debug')
    expect(entries[1]?.level).toBe('info')
    expect(entries[2]?.level).toBe('warn')
    expect(entries[3]?.level).toBe('error')
  })

  test('stores message content and category', () => {
    const category = `test-content-${Date.now()}`

    log.info(category, 'hello world')

    const entries = log.getEntries({ category })
    expect(entries.length).toBe(1)
    expect(entries[0]?.message).toBe('hello world')
    expect(entries[0]?.category).toBe(category)
  })

  test('stores optional data', () => {
    const category = `test-data-${Date.now()}`
    const data = { key: 'value', count: 42 }

    log.info(category, 'with data', data)

    const entries = log.getEntries({ category })
    expect(entries[0]?.data).toEqual(data)
  })

  test('filters entries by level', () => {
    const category = `test-filter-level-${Date.now()}`

    log.debug(category, 'debug')
    log.info(category, 'info')
    log.warn(category, 'warn')
    log.error(category, 'error')

    const warnings = log.getEntries({ category, level: 'warn' })
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.message).toBe('warn')

    const errors = log.getEntries({ category, level: 'error' })
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toBe('error')
  })

  test('limits number of returned entries', () => {
    const category = `test-limit-${Date.now()}`

    for (let i = 0; i < 10; i++) {
      log.info(category, `message ${i}`)
    }

    const limited = log.getEntries({ category, limit: 3 })
    expect(limited.length).toBe(3)
    // limit returns last N entries
    expect(limited[0]?.message).toBe('message 7')
    expect(limited[2]?.message).toBe('message 9')
  })

  test('entries have timestamps', () => {
    const category = `test-timestamp-${Date.now()}`
    const before = new Date()

    log.info(category, 'timed')

    const entries = log.getEntries({ category })
    expect(entries[0]?.timestamp).toBeInstanceOf(Date)
    expect(entries[0]?.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
  })

  test('combined category and level filtering', () => {
    const cat1 = `test-combined-a-${Date.now()}`
    const cat2 = `test-combined-b-${Date.now()}`

    log.info(cat1, 'info in cat1')
    log.error(cat1, 'error in cat1')
    log.info(cat2, 'info in cat2')
    log.error(cat2, 'error in cat2')

    const cat1Errors = log.getEntries({ category: cat1, level: 'error' })
    expect(cat1Errors.length).toBe(1)
    expect(cat1Errors[0]?.message).toBe('error in cat1')
  })
})

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
