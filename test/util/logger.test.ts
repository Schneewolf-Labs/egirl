import { describe, test, expect, beforeEach } from 'bun:test'

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
    expect(entries[0]!.level).toBe('debug')
    expect(entries[1]!.level).toBe('info')
    expect(entries[2]!.level).toBe('warn')
    expect(entries[3]!.level).toBe('error')
  })

  test('stores message content and category', () => {
    const category = `test-content-${Date.now()}`

    log.info(category, 'hello world')

    const entries = log.getEntries({ category })
    expect(entries.length).toBe(1)
    expect(entries[0]!.message).toBe('hello world')
    expect(entries[0]!.category).toBe(category)
  })

  test('stores optional data', () => {
    const category = `test-data-${Date.now()}`
    const data = { key: 'value', count: 42 }

    log.info(category, 'with data', data)

    const entries = log.getEntries({ category })
    expect(entries[0]!.data).toEqual(data)
  })

  test('filters entries by level', () => {
    const category = `test-filter-level-${Date.now()}`

    log.debug(category, 'debug')
    log.info(category, 'info')
    log.warn(category, 'warn')
    log.error(category, 'error')

    const warnings = log.getEntries({ category, level: 'warn' })
    expect(warnings.length).toBe(1)
    expect(warnings[0]!.message).toBe('warn')

    const errors = log.getEntries({ category, level: 'error' })
    expect(errors.length).toBe(1)
    expect(errors[0]!.message).toBe('error')
  })

  test('limits number of returned entries', () => {
    const category = `test-limit-${Date.now()}`

    for (let i = 0; i < 10; i++) {
      log.info(category, `message ${i}`)
    }

    const limited = log.getEntries({ category, limit: 3 })
    expect(limited.length).toBe(3)
    // limit returns last N entries
    expect(limited[0]!.message).toBe('message 7')
    expect(limited[2]!.message).toBe('message 9')
  })

  test('entries have timestamps', () => {
    const category = `test-timestamp-${Date.now()}`
    const before = new Date()

    log.info(category, 'timed')

    const entries = log.getEntries({ category })
    expect(entries[0]!.timestamp).toBeInstanceOf(Date)
    expect(entries[0]!.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
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
    expect(cat1Errors[0]!.message).toBe('error in cat1')
  })
})
