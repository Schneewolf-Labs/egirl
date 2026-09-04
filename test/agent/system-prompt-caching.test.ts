import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildSystemPrompt } from '../../src/agent/context'
import type { RuntimeConfig } from '../../src/config'

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'egirl-test-'))
  return dir
}

function makeConfig(workspacePath: string): RuntimeConfig {
  return {
    theme: 'egirl',
    thinking: { level: 'off', showThinking: true },
    workspace: { path: workspacePath },
    local: {
      endpoint: 'http://localhost:8080',
      model: 'test',
      contextLength: 32768,
      maxConcurrent: 2,
      staleStreamTimeoutMs: 90000,
    },
    remote: {},
    routing: {
      disabled: false,
      default: 'local',
      escalationThreshold: 0.4,
      alwaysLocal: [],
      alwaysRemote: [],
    },
    channels: {},
    conversation: {
      enabled: false,
      maxAgeDays: 30,
      maxMessages: 1000,
      compactOnStartup: false,
      contextCompaction: false,
    },
    memory: {
      proactiveRetrieval: false,
      scoreThreshold: 0.35,
      maxResults: 5,
      maxTokensBudget: 2000,
      autoExtract: false,
      extractionMinMessages: 2,
      extractionMaxPerTurn: 5,
    },
    safety: {
      enabled: true,
      commandFilter: { enabled: true, mode: 'block', blockedPatterns: [], extraAllowed: [] },
      pathSandbox: { enabled: false, allowedPaths: [] },
      sensitiveFiles: { enabled: true, patterns: [] },
      auditLog: { enabled: false },
      confirmation: { enabled: false, tools: [] },
      permissionRules: { allow: [], deny: [] },
    },
    energy: { enabled: false, maxEnergy: 20, regenPerHour: 10 },
    tasks: {
      enabled: false,
      tickIntervalMs: 30000,
      maxActiveTasks: 20,
      maxConcurrentTasks: 1,
      taskTimeoutMs: 300000,
      discoveryEnabled: false,
      discoveryIntervalMs: 60000,
      idleThresholdMs: 300000,
      heartbeat: { enabled: false, schedule: '0 9 * * 1-5' },
    },
    tools: {
      files: true,
      exec: true,
      git: true,
      memory: true,
      browser: false,
      github: false,
      tasks: false,
      codeAgent: false,
      webResearch: false,
      screenshot: false,
    },
    skills: { dirs: [] },
  } as RuntimeConfig
}

describe('buildSystemPrompt', () => {
  test('returns stable and volatile parts', () => {
    const workspace = makeTempWorkspace()
    writeFileSync(join(workspace, 'IDENTITY.md'), 'I am Kira')
    writeFileSync(join(workspace, 'SOUL.md'), 'Be helpful and kind')
    writeFileSync(join(workspace, 'MEMORY.md'), 'Remember: user likes TypeScript')

    const config = makeConfig(workspace)
    const parts = buildSystemPrompt(config)

    expect(parts.full).toBeTruthy()
    expect(parts.stable).toBeTruthy()
    expect(parts.volatile).toBeTruthy()

    // Full should be stable + separator + volatile
    expect(parts.full).toContain(parts.stable)
    expect(parts.full).toContain(parts.volatile)

    // Identity and soul are stable
    expect(parts.stable).toContain('I am Kira')
    expect(parts.stable).toContain('Be helpful and kind')

    // Working memory is volatile
    expect(parts.volatile).toContain('user likes TypeScript')

    // Stable should NOT contain volatile content
    expect(parts.stable).not.toContain('user likes TypeScript')
  })

  test('stable includes tool descriptions', () => {
    const workspace = makeTempWorkspace()
    writeFileSync(join(workspace, 'IDENTITY.md'), 'I am Kira')

    const config = makeConfig(workspace)
    const parts = buildSystemPrompt(config)

    expect(parts.stable).toContain('Available Tools')
    expect(parts.stable).toContain('read_file')
  })

  test('volatile is empty when no memory or additional context', () => {
    const workspace = makeTempWorkspace()
    writeFileSync(join(workspace, 'IDENTITY.md'), 'I am Kira')

    const config = makeConfig(workspace)
    const parts = buildSystemPrompt(config)

    expect(parts.volatile).toBe('')
    expect(parts.full).toBe(parts.stable)
  })

  test('additional context is classified as volatile', () => {
    const workspace = makeTempWorkspace()
    writeFileSync(join(workspace, 'IDENTITY.md'), 'I am Kira')

    const config = makeConfig(workspace)
    const parts = buildSystemPrompt(config, {
      additionalContext: 'Current task: write tests',
    })

    expect(parts.volatile).toContain('Current task: write tests')
    expect(parts.stable).not.toContain('Current task')
  })

  test('skills are classified as stable', () => {
    const workspace = makeTempWorkspace()
    writeFileSync(join(workspace, 'IDENTITY.md'), 'I am Kira')

    const config = makeConfig(workspace)
    const parts = buildSystemPrompt(config, {
      skills: [
        {
          name: 'Code Review',
          description: 'Review code for quality',
          content: 'When reviewing code...',
          metadata: {},
        },
      ],
    })

    expect(parts.stable).toContain('Code Review')
    expect(parts.volatile).not.toContain('Code Review')
  })
})

describe('Anthropic cache_control integration', () => {
  test('systemPromptParts shape is correct for Anthropic', () => {
    const workspace = makeTempWorkspace()
    writeFileSync(join(workspace, 'IDENTITY.md'), 'I am Kira')
    writeFileSync(join(workspace, 'MEMORY.md'), 'Working memory content')

    const config = makeConfig(workspace)
    const parts = buildSystemPrompt(config)

    // Simulate what loop.ts does: pass parts to Anthropic provider
    const promptParts = {
      stable: parts.stable,
      volatile: parts.volatile,
    }

    // Simulate what Anthropic provider would build
    const blocks = [
      { type: 'text', text: promptParts.stable, cache_control: { type: 'ephemeral' } },
    ]
    if (promptParts.volatile) {
      blocks.push({ type: 'text', text: promptParts.volatile } as (typeof blocks)[0])
    }

    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[1]?.text).toContain('Working memory')
  })
})
