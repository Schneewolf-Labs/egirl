import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RuntimeConfig } from '../../src/config'
import type { ChatResponse } from '../../src/providers/types'
import type { ToolExecutor } from '../../src/tools'
import { createToolExecutor } from '../../src/tools/executor'

export function makeConfig(workspacePath: string): RuntimeConfig {
  return {
    theme: 'egirl',
    thinking: { level: 'off', showThinking: true },
    workspace: { path: workspacePath },
    local: {
      endpoint: 'http://localhost:1',
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
      enabled: false,
      commandFilter: { enabled: false, mode: 'block', blockedPatterns: [], extraAllowed: [] },
      pathSandbox: { enabled: false, allowedPaths: [] },
      sensitiveFiles: { enabled: false, patterns: [] },
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
    transcript: { enabled: false, path: '' },
    tools: {
      files: false,
      exec: false,
      git: false,
      memory: false,
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

export function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'egirl-loop-test-'))
}

export function makeExecutorWithNoop(): ToolExecutor {
  const executor = createToolExecutor()
  executor.register({
    definition: {
      name: 'noop',
      description: 'does nothing',
      parameters: { type: 'object', properties: {} },
    },
    execute: async () => ({ success: true, output: 'ok' }),
  })
  return executor
}

export function stubResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content: '',
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'stub',
    finish_reason: 'stop',
    ...overrides,
  }
}
