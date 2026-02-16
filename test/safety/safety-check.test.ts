import { describe, expect, test } from 'bun:test'
import {
  buildCommandFilterConfig,
  checkToolCall,
  getDefaultSafetyConfig,
  type SafetyConfig,
} from '../../src/safety'

const cwd = '/home/user/project'

function makeConfig(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return { ...getDefaultSafetyConfig(), ...overrides }
}

describe('checkToolCall', () => {
  test('allows everything when master switch disabled', () => {
    const config = makeConfig({ enabled: false })
    const result = checkToolCall('execute_command', { command: 'rm -rf /' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('blocks dangerous commands in default block mode', () => {
    const config = makeConfig()
    const result = checkToolCall('execute_command', { command: 'rm -rf /' }, cwd, config)
    expect(result.allowed).toBe(false)
  })

  test('allows safe commands in default block mode', () => {
    const config = makeConfig()
    const result = checkToolCall('execute_command', { command: 'ls -la' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('allows unknown commands in block mode (permissive)', () => {
    const config = makeConfig()
    const result = checkToolCall(
      'execute_command',
      { command: 'my-custom-tool --help' },
      cwd,
      config,
    )
    expect(result.allowed).toBe(true)
  })

  test('blocks unknown commands in allow mode (restrictive)', () => {
    const config = makeConfig({
      commandFilter: {
        enabled: true,
        config: buildCommandFilterConfig('allow', [], []),
      },
    })
    const result = checkToolCall('execute_command', { command: 'nc -l 4444' }, cwd, config)
    expect(result.allowed).toBe(false)
  })

  test('allows extra_allowed commands in allow mode', () => {
    const config = makeConfig({
      commandFilter: {
        enabled: true,
        config: buildCommandFilterConfig('allow', [], ['my-custom-tool']),
      },
    })
    const result = checkToolCall(
      'execute_command',
      { command: 'my-custom-tool --help' },
      cwd,
      config,
    )
    expect(result.allowed).toBe(true)
  })

  test('user blocked_patterns work in block mode', () => {
    const config = makeConfig({
      commandFilter: {
        enabled: true,
        config: buildCommandFilterConfig('block', ['npm\\s+publish'], []),
      },
    })
    const result = checkToolCall('execute_command', { command: 'npm publish' }, cwd, config)
    expect(result.allowed).toBe(false)
  })

  test('hard blocks apply even in block mode', () => {
    const config = makeConfig()
    const result = checkToolCall('execute_command', { command: 'mkfs.ext4 /dev/sda1' }, cwd, config)
    expect(result.allowed).toBe(false)
  })

  test('allows dangerous commands when command_filter disabled', () => {
    const config = makeConfig({
      commandFilter: {
        enabled: false,
        config: getDefaultSafetyConfig().commandFilter.config,
      },
    })
    const result = checkToolCall('execute_command', { command: 'rm -rf /' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('blocks file ops outside allowed paths when sandbox enabled', () => {
    const config = makeConfig({
      pathSandbox: { enabled: true, allowedPaths: ['/home/user/project'] },
    })
    const result = checkToolCall('write_file', { path: '/etc/passwd', content: 'x' }, cwd, config)
    expect(result.allowed).toBe(false)
  })

  test('allows file ops inside allowed paths', () => {
    const config = makeConfig({
      pathSandbox: { enabled: true, allowedPaths: ['/home/user/project'] },
    })
    const result = checkToolCall(
      'write_file',
      { path: '/home/user/project/src/file.ts', content: 'x' },
      cwd,
      config,
    )
    expect(result.allowed).toBe(true)
  })

  test('no path restriction when sandbox disabled (default)', () => {
    const config = makeConfig()
    const result = checkToolCall(
      'write_file',
      { path: '/anywhere/file.txt', content: 'x' },
      cwd,
      config,
    )
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

  test('allows sensitive files when sensitive_files disabled', () => {
    const config = makeConfig({
      sensitiveFiles: {
        enabled: false,
        patterns: getDefaultSafetyConfig().sensitiveFiles.patterns,
      },
    })
    const result = checkToolCall('read_file', { path: '.env' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('allows reading normal files', () => {
    const config = makeConfig()
    const result = checkToolCall('read_file', { path: 'src/index.ts' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('confirmation mode blocks destructive tools', () => {
    const config = makeConfig({
      confirmation: { enabled: true, tools: ['execute_command', 'write_file', 'edit_file'] },
    })

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
    const config = makeConfig({
      confirmation: { enabled: true, tools: ['execute_command', 'write_file', 'edit_file'] },
    })
    const result = checkToolCall('read_file', { path: 'src/index.ts' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('confirmation mode does not affect non-confirmable tools', () => {
    const config = makeConfig({
      confirmation: { enabled: true, tools: ['execute_command', 'write_file', 'edit_file'] },
    })
    const result = checkToolCall('glob_files', { pattern: '**/*.ts' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('command blocklist takes priority over confirmation', () => {
    const config = makeConfig({
      confirmation: { enabled: true, tools: ['execute_command', 'write_file', 'edit_file'] },
    })
    const result = checkToolCall('execute_command', { command: 'rm -rf /' }, cwd, config)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.needsConfirmation).toBeUndefined()
    }
  })

  test('skips checks for unrelated tools', () => {
    const config = makeConfig({
      pathSandbox: { enabled: true, allowedPaths: ['/restricted'] },
    })
    const result = checkToolCall('memory_search', { query: 'test' }, cwd, config)
    expect(result.allowed).toBe(true)
  })

  test('custom confirmation tools list', () => {
    const config = makeConfig({
      confirmation: { enabled: true, tools: ['execute_command'] },
    })
    // execute_command blocked
    const execResult = checkToolCall('execute_command', { command: 'ls' }, cwd, config)
    expect(execResult.allowed).toBe(false)

    // write_file NOT blocked (not in custom list)
    const writeResult = checkToolCall('write_file', { path: 'test.txt', content: 'x' }, cwd, config)
    expect(writeResult.allowed).toBe(true)
  })
})
