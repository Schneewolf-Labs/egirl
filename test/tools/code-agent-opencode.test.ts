import { describe, expect, test } from 'bun:test'
import { buildOpencodeArgs } from '../../src/tools/builtin/code-agent/opencode'
import type { CodeAgentConfig } from '../../src/tools/builtin/code-agent/types'

function configWith(overrides: Partial<CodeAgentConfig>): CodeAgentConfig {
  return {
    permissionMode: 'default',
    workingDir: '/tmp/work',
    ...overrides,
  }
}

describe('buildOpencodeArgs', () => {
  test('runs headless against the working dir with default formatting', () => {
    const args = buildOpencodeArgs(configWith({}), 'fix the bug', '/repo')
    expect(args[0]).toBe('run')
    expect(args).toContain('--dir')
    expect(args[args.indexOf('--dir') + 1]).toBe('/repo')
    expect(args).toContain('--format')
    expect(args[args.indexOf('--format') + 1]).toBe('default')
    // task is the trailing positional
    expect(args[args.length - 1]).toBe('fix the bug')
  })

  test('bypassPermissions skips permission prompts', () => {
    const args = buildOpencodeArgs(configWith({ permissionMode: 'bypassPermissions' }), 't', '/r')
    expect(args).toContain('--dangerously-skip-permissions')
  })

  test('acceptEdits skips permission prompts', () => {
    const args = buildOpencodeArgs(configWith({ permissionMode: 'acceptEdits' }), 't', '/r')
    expect(args).toContain('--dangerously-skip-permissions')
  })

  test('default mode keeps opencode permission config (no skip flag)', () => {
    const args = buildOpencodeArgs(configWith({ permissionMode: 'default' }), 't', '/r')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--agent')
  })

  test('plan mode runs the opencode plan agent', () => {
    const args = buildOpencodeArgs(configWith({ permissionMode: 'plan' }), 't', '/r')
    expect(args).toContain('--agent')
    expect(args[args.indexOf('--agent') + 1]).toBe('plan')
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  test('passes provider/model through to --model', () => {
    const args = buildOpencodeArgs(configWith({ model: 'anthropic/claude-sonnet-4-5' }), 't', '/r')
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-4-5')
  })

  test('omits --model when no model configured', () => {
    const args = buildOpencodeArgs(configWith({}), 't', '/r')
    expect(args).not.toContain('--model')
  })
})
