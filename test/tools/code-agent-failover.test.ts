import { describe, expect, test } from 'bun:test'
import { resolveProviderChain, shouldFailover } from '../../src/tools/builtin/code-agent/failover'
import type { ToolResult } from '../../src/tools/types'

/**
 * Failover has to distinguish "this backend could not run the task" from "the agent ran and did
 * not solve it". The first is worth retrying elsewhere; the second is the answer, and retrying it
 * burns every configured provider on one impossible task and layers three agents' partial edits
 * on the same tree.
 *
 * Both failure kinds were observed in one afternoon, each while another backend sat idle:
 * codex exited 0 in 0.1s with an empty transcript, and opencode returned
 * 401 "Model glm-4.7-free is not supported" because the account was signed out.
 */

const fail = (output: string): ToolResult => ({ success: false, output })

describe('shouldFailover', () => {
  test('success never fails over', () => {
    expect(shouldFailover({ success: true, output: 'done' })).toBe(false)
  })

  test('an empty transcript fails over — the backend never ran', () => {
    expect(
      shouldFailover(fail('Code agent produced no output (exit 0, 0.1s) in /home/u/.egirl')),
    ).toBe(true)
  })

  test('auth and credit problems fail over', () => {
    expect(shouldFailover(fail('Code agent error: {"statusCode":401,"message":"..."}'))).toBe(true)
    expect(shouldFailover(fail('api_key not configured (no-tty)'))).toBe(true)
    expect(shouldFailover(fail('429 rate-limit exceeded'))).toBe(true)
    expect(shouldFailover(fail('credits exhausted for this account'))).toBe(true)
  })

  test('a missing binary fails over', () => {
    expect(shouldFailover(fail('spawn codex ENOENT'))).toBe(true)
    expect(shouldFailover(fail('opencode not found on PATH'))).toBe(true)
  })

  test('an agent that ran and reported failure does NOT fail over', () => {
    const transcript = fail(
      `I explored the repository and attempted a fix. ${'The tests still fail because the '.repeat(
        20,
      )} I could not resolve this without more context about the intended behaviour.`,
    )
    expect(shouldFailover(transcript)).toBe(false)
  })

  test('an unrecognised short failure does not fail over either', () => {
    // Conservative by design: only known infrastructure signals justify spending another provider.
    expect(shouldFailover(fail('something went wrong'))).toBe(false)
  })
})

describe('resolveProviderChain', () => {
  test('providers wins when set', () => {
    expect(resolveProviderChain(['codex', 'opencode'], 'claude', 'claude')).toEqual([
      'codex',
      'opencode',
    ])
  })

  test('a single provider keeps the old single-attempt behaviour', () => {
    expect(resolveProviderChain(undefined, 'codex', 'claude')).toEqual(['codex'])
  })

  test('falls back to the default when nothing is configured', () => {
    expect(resolveProviderChain(undefined, undefined, 'claude')).toEqual(['claude'])
  })

  test('duplicates are collapsed — retrying the same backend repeats the same failure', () => {
    expect(resolveProviderChain(['codex', 'codex', 'opencode'], undefined, 'claude')).toEqual([
      'codex',
      'opencode',
    ])
  })
})
