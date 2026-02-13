import { describe, test, expect } from 'bun:test'
import { checkToolCall, getDefaultSafetyConfig, type SafetyConfig } from '../../src/safety'

const cwd = '/home/user/project'

function makeConfig(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return { ...getDefaultSafetyConfig(), ...overrides }
}

describe('checkToolCall', () => {
  test('allows everything when disabled', () => {
    const config = makeConfig({ enabled: false })
    const result = checkToolCall('execute_command', { command: 'rm -rf /' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('blocks dangerous commands', () => {
    const config = makeConfig()
    const result = checkToolCall('execute_command', { command: 'rm -rf /' }, cwd, config)
    expect(result.allowed).toBe(false)
  })

  test('allows safe commands', () => {
    const config = makeConfig()
    const result = checkToolCall('execute_command', { command: 'ls -la' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('blocks file ops outside allowed paths', () => {
    const config = makeConfig({ allowedPaths: ['/home/user/project'] })
    const result = checkToolCall('write_file', { path: '/etc/passwd', content: 'x' }, cwd, config)
    expect(result.allowed).toBe(false)
  })

  test('allows file ops inside allowed paths', () => {
    const config = makeConfig({ allowedPaths: ['/home/user/project'] })
    const result = checkToolCall('write_file', { path: '/home/user/project/src/file.ts', content: 'x' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('no path restriction when allowedPaths is empty', () => {
    const config = makeConfig({ allowedPaths: [] })
    const result = checkToolCall('write_file', { path: '/anywhere/file.txt', content: 'x' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('blocks sensitive file reads', () => {
    const config = makeConfig()
    const result = checkToolCall('read_file', { path: '/home/user/.ssh/id_rsa' }, cwd, config)
    expect(result.allowed).toBe(false)
  })

  test('blocks sensitive file writes', () => {
    const config = makeConfig()
    const result = checkToolCall('write_file', { path: '.env', content: 'SECRET=x' }, cwd, config)
    expect(result.allowed).toBe(false)
  })

  test('allows reading normal files', () => {
    const config = makeConfig()
    const result = checkToolCall('read_file', { path: 'src/index.ts' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('confirmation mode blocks destructive tools', () => {
    const config = makeConfig({ requireConfirmation: true })

    const execResult = checkToolCall('execute_command', { command: 'ls' }, cwd, config)
    expect(execResult.allowed).toBe(false)
    if (!execResult.allowed) {
      expect(execResult.needsConfirmation).toBe(true)
    }

    const writeResult = checkToolCall('write_file', { path: 'test.txt', content: 'x' }, cwd, config)
    expect(writeResult.allowed).toBe(false)
    if (!writeResult.allowed) {
      expect(writeResult.needsConfirmation).toBe(true)
    }
  })

  test('confirmation mode does not block read-only tools', () => {
    const config = makeConfig({ requireConfirmation: true })
    const result = checkToolCall('read_file', { path: 'src/index.ts' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('confirmation mode does not affect non-confirmable tools', () => {
    const config = makeConfig({ requireConfirmation: true })
    const result = checkToolCall('glob_files', { pattern: '**/*.ts' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('command blocklist takes priority over confirmation', () => {
    const config = makeConfig({ requireConfirmation: true })
    const result = checkToolCall('execute_command', { command: 'rm -rf /' }, cwd, config)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.needsConfirmation).toBeUndefined()
    }
  })

  test('skips checks for unrelated tools', () => {
    const config = makeConfig({ allowedPaths: ['/restricted'] })
    const result = checkToolCall('memory_search', { query: 'test' }, cwd, config)
    expect(result.allowed).toBe(true)
  })
})
