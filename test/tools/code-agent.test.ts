import { describe, expect, test } from 'bun:test'
import {
  buildCliInvocation,
  type CodeAgentConfig,
  codexApprovalMode,
  opencodePermission,
  resolveCodeAgentBackend,
} from '../../src/tools/builtin/code-agent'

describe('code-agent backend config', () => {
  const base: CodeAgentConfig = {
    permissionMode: 'default',
    workingDir: '/tmp',
  }

  test('defaults backend to opencode', () => {
    expect(resolveCodeAgentBackend(base)).toBe('opencode')
  })

  test('maps permission modes for codex approvals', () => {
    expect(codexApprovalMode('default')).toBe('suggest')
    expect(codexApprovalMode('plan')).toBe('suggest')
    expect(codexApprovalMode('acceptEdits')).toBe('auto-edit')
    expect(codexApprovalMode('bypassPermissions')).toBe('full-auto')
  })

  test('maps permission modes for opencode policy', () => {
    expect(opencodePermission('default')).toContain('"*":"ask"')
    expect(opencodePermission('plan')).toContain('"*":"ask"')
    expect(opencodePermission('acceptEdits')).toContain('"edit":"allow"')
    expect(opencodePermission('bypassPermissions')).toContain('"*":"allow"')
  })

  test('builds codex invocation with approval mode and model', () => {
    const invocation = buildCliInvocation('codex', 'fix tests', {
      ...base,
      permissionMode: 'acceptEdits',
      model: 'gpt-5-codex',
    })

    expect(invocation.args).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--approval-mode',
      'auto-edit',
      '--model',
      'gpt-5-codex',
      'fix tests',
    ])
    expect(invocation.env).toEqual({})
  })

  test('builds opencode invocation with permission env', () => {
    const invocation = buildCliInvocation('opencode', 'write fibonacci', {
      ...base,
      permissionMode: 'bypassPermissions',
    })

    expect(invocation.args).toEqual(['write fibonacci'])
    expect(invocation.env.OPENCODE_PERMISSION).toContain('"*":"allow"')
  })

  test('builds hermes invocation with one-shot query mode', () => {
    const invocation = buildCliInvocation('hermes', 'write fibonacci', {
      ...base,
      permissionMode: 'bypassPermissions',
      model: 'nous:hermes-4',
    })

    expect(invocation.args).toEqual([
      'chat',
      '-q',
      'write fibonacci',
      '-Q',
      '--model',
      'nous:hermes-4',
      '--yolo',
    ])
    expect(invocation.env).toEqual({})
  })
})
