import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { logCommand } from '../../src/channels/cli-log'
import { type LogLevel, log } from '../../src/util/logger'

let saved: LogLevel

beforeEach(() => {
  saved = log.getLevel()
  log.setLevel('info')
})

afterEach(() => {
  log.setLevel(saved)
})

describe('/log', () => {
  test('lists the levels and marks the current one', () => {
    const out = logCommand('').replaceAll(
      new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'),
      '',
    )
    for (const l of ['debug', 'info', 'warn', 'error']) expect(out).toContain(l)
    expect(out).toContain('› info')
  })

  test('changes the level for the session', () => {
    expect(logCommand(' DEBUG')).toContain('log: info → debug')
    expect(log.getLevel()).toBe('debug')
    logCommand('warn')
    expect(log.getLevel()).toBe('warn')
  })

  test('an unknown level changes nothing', () => {
    expect(logCommand('loud')).toContain('No log level "loud"')
    expect(log.getLevel()).toBe('info')
  })
})
