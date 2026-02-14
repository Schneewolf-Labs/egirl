import { Type, Static } from '@sinclair/typebox'

export const EgirlConfigSchema = Type.Object({
  workspace: Type.Object({
    path: Type.String({ default: '~/.egirl/workspace' }),
  }),

  local: Type.Object({
    endpoint: Type.String({ default: 'http://localhost:8080' }),
    model: Type.String({ default: 'qwen2.5-32b-instruct' }),
    context_length: Type.Number({ default: 32768 }),
    max_concurrent: Type.Number({ default: 2 }),
    embeddings: Type.Optional(Type.Object({
      endpoint: Type.String({ default: 'http://localhost:8082' }),
      model: Type.String({ default: 'qwen3-vl-embedding-2b' }),
      dimensions: Type.Number({ default: 2048 }),
      multimodal: Type.Boolean({ default: true }),
    })),
  }),

  routing: Type.Object({
    default: Type.Union([Type.Literal('local'), Type.Literal('remote')], { default: 'local' }),
    escalation_threshold: Type.Number({ default: 0.4 }),
    always_local: Type.Array(Type.String(), { default: ['memory_search', 'memory_get', 'greeting', 'acknowledgment'] }),
    always_remote: Type.Array(Type.String(), { default: ['code_generation', 'code_review', 'complex_reasoning'] }),
  }),

  channels: Type.Optional(Type.Object({
    discord: Type.Optional(Type.Object({
      allowed_channels: Type.Array(Type.String(), { default: ['dm'] }),
      allowed_users: Type.Array(Type.String(), { default: [] }),
      passive_channels: Type.Array(Type.String(), { default: [] }),
      batch_window_ms: Type.Number({ default: 3000 }),
    })),
    claude_code: Type.Optional(Type.Object({
      permission_mode: Type.Union([
        Type.Literal('default'),
        Type.Literal('acceptEdits'),
        Type.Literal('bypassPermissions'),
        Type.Literal('plan'),
      ], { default: 'bypassPermissions' }),
      model: Type.Optional(Type.String()),
      working_dir: Type.Optional(Type.String()),
      max_turns: Type.Optional(Type.Number()),
    })),
    xmpp: Type.Optional(Type.Object({
      service: Type.String({ default: 'xmpp://localhost:5222' }),
      domain: Type.Optional(Type.String()),
      resource: Type.Optional(Type.String()),
      allowed_jids: Type.Array(Type.String(), { default: [] }),
    })),
    api: Type.Optional(Type.Object({
      port: Type.Number({ default: 3000 }),
      host: Type.String({ default: '127.0.0.1' }),
    })),
  })),

  conversation: Type.Optional(Type.Object({
    enabled: Type.Boolean({ default: true }),
    max_age_days: Type.Number({ default: 30 }),
    max_messages: Type.Number({ default: 1000 }),
    compact_on_startup: Type.Boolean({ default: true }),
    context_compaction: Type.Boolean({ default: true }),
  })),

  memory: Type.Optional(Type.Object({
    proactive_retrieval: Type.Boolean({ default: true }),
    score_threshold: Type.Number({ default: 0.35 }),
    max_results: Type.Number({ default: 5 }),
    max_tokens_budget: Type.Number({ default: 2000 }),
    auto_extract: Type.Boolean({ default: true }),
    extraction_min_messages: Type.Number({ default: 2 }),
    extraction_max_per_turn: Type.Number({ default: 5 }),
  })),

  safety: Type.Optional(Type.Object({
    enabled: Type.Boolean({ default: true }),
    command_filter: Type.Optional(Type.Object({
      enabled: Type.Boolean({ default: true }),
      blocked_patterns: Type.Optional(Type.Array(Type.String())),
    })),
    path_sandbox: Type.Optional(Type.Object({
      enabled: Type.Boolean({ default: false }),
      allowed_paths: Type.Optional(Type.Array(Type.String())),
    })),
    sensitive_files: Type.Optional(Type.Object({
      enabled: Type.Boolean({ default: true }),
      patterns: Type.Optional(Type.Array(Type.String())),
    })),
    audit_log: Type.Optional(Type.Object({
      enabled: Type.Boolean({ default: true }),
      path: Type.Optional(Type.String()),
    })),
    confirmation: Type.Optional(Type.Object({
      enabled: Type.Boolean({ default: false }),
      tools: Type.Optional(Type.Array(Type.String())),
    })),
  })),

  github: Type.Optional(Type.Object({
    default_owner: Type.Optional(Type.String()),
    default_repo: Type.Optional(Type.String()),
  })),

  tasks: Type.Optional(Type.Object({
    enabled: Type.Boolean({ default: true }),
    tick_interval_ms: Type.Number({ default: 30000 }),
    max_active_tasks: Type.Number({ default: 20 }),
    task_timeout_ms: Type.Number({ default: 300000 }),
    discovery_enabled: Type.Boolean({ default: true }),
    discovery_interval_ms: Type.Number({ default: 1800000 }),
    idle_threshold_ms: Type.Number({ default: 600000 }),
  })),

  skills: Type.Object({
    dirs: Type.Array(Type.String(), { default: ['~/.egirl/skills', '{workspace}/skills'] }),
  }),
})

export type EgirlConfig = Static<typeof EgirlConfigSchema>

// Runtime config with resolved paths and secrets from .env
export interface RuntimeConfig {
  workspace: {
    path: string
  }
  local: {
    endpoint: string
    model: string
    contextLength: number
    maxConcurrent: number
    embeddings?: {
      endpoint: string
      model: string
      dimensions: number
      multimodal: boolean
    }
  }
  remote: {
    anthropic?: {
      apiKey: string
      model: string
    }
    openai?: {
      apiKey: string
      model: string
      baseUrl?: string
    }
  }
  routing: {
    default: 'local' | 'remote'
    escalationThreshold: number
    alwaysLocal: string[]
    alwaysRemote: string[]
  }
  channels: {
    discord?: {
      token: string
      allowedChannels: string[]
      allowedUsers: string[]
      passiveChannels: string[]
      batchWindowMs: number
    }
    claudeCode?: {
      permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
      model?: string
      workingDir: string
      maxTurns?: number
    }
    xmpp?: {
      service: string
      domain: string
      username: string
      password: string
      resource?: string
      allowedJids: string[]
    }
    api?: {
      port: number
      host: string
    }
  }
  conversation: {
    enabled: boolean
    maxAgeDays: number
    maxMessages: number
    compactOnStartup: boolean
    contextCompaction: boolean
  }
  memory: {
    proactiveRetrieval: boolean
    scoreThreshold: number
    maxResults: number
    maxTokensBudget: number
    autoExtract: boolean
    extractionMinMessages: number
    extractionMaxPerTurn: number
  }
  safety: {
    enabled: boolean
    commandFilter: {
      enabled: boolean
      blockedPatterns: string[]
    }
    pathSandbox: {
      enabled: boolean
      allowedPaths: string[]
    }
    sensitiveFiles: {
      enabled: boolean
      patterns: string[]
    }
    auditLog: {
      enabled: boolean
      path?: string
    }
    confirmation: {
      enabled: boolean
      tools: string[]
    }
  }
  github?: {
    token: string
    defaultOwner?: string
    defaultRepo?: string
  }
  tasks: {
    enabled: boolean
    tickIntervalMs: number
    maxActiveTasks: number
    taskTimeoutMs: number
    discoveryEnabled: boolean
    discoveryIntervalMs: number
    idleThresholdMs: number
  }
  skills: {
    dirs: string[]
  }
}
