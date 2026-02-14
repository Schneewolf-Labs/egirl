import { afterEach, describe, expect, test } from 'bun:test'
import { applyLogLevel } from '../../src/util/args'
import { log } from '../../src/util/logger'

describe('applyLogLevel', () => {
  afterEach(() => {
    // Reset to default
    log.setLevel('info')
  })

  test('sets error level for --quiet', () => {
    applyLogLevel(['--quiet'])
    expect(log.getLevel()).toBe('error')
  })

  test('sets error level for -q', () => {
    applyLogLevel(['-q'])
    expect(log.getLevel()).toBe('error')
  })

  test('sets debug level for --verbose', () => {
    applyLogLevel(['--verbose'])
    expect(log.getLevel()).toBe('debug')
  })

  test('sets debug level for -v', () => {
    applyLogLevel(['-v'])
    expect(log.getLevel()).toBe('debug')
  })

  test('sets debug level for --debug', () => {
    applyLogLevel(['--debug'])
    expect(log.getLevel()).toBe('debug')
  })

  test('sets debug level for -d', () => {
    applyLogLevel(['-d'])
    expect(log.getLevel()).toBe('debug')
  })

  test('does not change level for no matching flags', () => {
    const before = log.getLevel()
    applyLogLevel(['--some-other-flag'])
    expect(log.getLevel()).toBe(before)
  })
})
