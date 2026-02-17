import { type Static, Type } from '@sinclair/typebox'

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

export const EgirlConfigSchema = Type.Object({
  theme: Type.Optional(Type.String({ default: 'egirl' })),

  thinking: Type.Optional(
    Type.Object({
      level: Type.Union(
        [Type.Literal('off'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')],
        { default: 'off' },
      ),
      budget_tokens: Type.Optional(Type.Number()),
      show_thinking: Type.Boolean({ default: true }),
    }),
  ),

  workspace: Type.Object({
    path: Type.String({ default: '~/.egirl/workspace' }),
  }),

  local: Type.Object({
    endpoint: Type.String({ default: 'http://localhost:8080' }),
    model: Type.String({ default: 'qwen2.5-32b-instruct' }),
    context_length: Type.Number({ default: 32768 }),
    max_concurrent: Type.Number({ default: 2 }),
    embeddings: Type.Optional(
      Type.Object({
        endpoint: Type.String({ default: 'http://localhost:8082' }),
        model: Type.String({ default: 'qwen3-vl-embedding-2b' }),
        dimensions: Type.Number({ default: 2048 }),
        multimodal: Type.Boolean({ default: true }),
      }),
    ),
  }),

  routing: Type.Object({
    default: Type.Union([Type.Literal('local'), Type.Literal('remote')], { default: 'local' }),
    escalation_threshold: Type.Number({ default: 0.4 }),
    always_local: Type.Array(Type.String(), {
      default: ['memory_search', 'memory_get', 'greeting', 'acknowledgment'],
    }),
    always_remote: Type.Array(Type.String(), {
      default: ['code_generation', 'code_review', 'complex_reasoning'],
    }),
    models: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
  }),

  channels: Type.Optional(
    Type.Object({
      discord: Type.Optional(
        Type.Object({
          allowed_channels: Type.Array(Type.String(), { default: ['dm'] }),
          allowed_users: Type.Array(Type.String(), { default: [] }),
          passive_channels: Type.Array(Type.String(), { default: [] }),
          batch_window_ms: Type.Number({ default: 3000 }),
        }),
      ),
      claude_code: Type.Optional(
        Type.Object({
          permission_mode: Type.Union(
            [
              Type.Literal('default'),
              Type.Literal('acceptEdits'),
              Type.Literal('bypassPermissions'),
              Type.Literal('plan'),
            ],
            { default: 'bypassPermissions' },
          ),
          model: Type.Optional(Type.String()),
          working_dir: Type.Optional(Type.String()),
          max_turns: Type.Optional(Type.Number()),
        }),
      ),
      xmpp: Type.Optional(
        Type.Object({
          service: Type.String({ default: 'xmpp://localhost:5222' }),
          domain: Type.Optional(Type.String()),
          resource: Type.Optional(Type.String()),
          allowed_jids: Type.Array(Type.String(), { default: [] }),
        }),
      ),
      api: Type.Optional(
        Type.Object({
          port: Type.Number({ default: 3000 }),
          host: Type.String({ default: '127.0.0.1' }),
          rate_limit: Type.Optional(Type.Number({ default: 30 })),
          max_request_bytes: Type.Optional(Type.Number({ default: 65536 })),
          cors_origins: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
  ),

  conversation: Type.Optional(
    Type.Object({
      enabled: Type.Boolean({ default: true }),
      max_age_days: Type.Number({ default: 30 }),
      max_messages: Type.Number({ default: 1000 }),
      compact_on_startup: Type.Boolean({ default: true }),
      context_compaction: Type.Boolean({ default: true }),
    }),
  ),

  memory: Type.Optional(
    Type.Object({
      proactive_retrieval: Type.Boolean({ default: true }),
      score_threshold: Type.Number({ default: 0.35 }),
      max_results: Type.Number({ default: 5 }),
      max_tokens_budget: Type.Number({ default: 2000 }),
      auto_extract: Type.Boolean({ default: true }),
      extraction_min_messages: Type.Number({ default: 2 }),
      extraction_max_per_turn: Type.Number({ default: 5 }),
    }),
  ),

  safety: Type.Optional(
    Type.Object({
      enabled: Type.Boolean({ default: true }),
      command_filter: Type.Optional(
        Type.Object({
          enabled: Type.Boolean({ default: true }),
          mode: Type.Optional(
            Type.Union([Type.Literal('block'), Type.Literal('allow')], { default: 'block' }),
          ),
          blocked_patterns: Type.Optional(Type.Array(Type.String())),
          extra_allowed: Type.Optional(Type.Array(Type.String())),
        }),
      ),
      path_sandbox: Type.Optional(
        Type.Object({
          enabled: Type.Boolean({ default: true }),
          allowed_paths: Type.Optional(Type.Array(Type.String())),
        }),
      ),
      sensitive_files: Type.Optional(
        Type.Object({
          enabled: Type.Boolean({ default: true }),
          patterns: Type.Optional(Type.Array(Type.String())),
        }),
      ),
      audit_log: Type.Optional(
        Type.Object({
          enabled: Type.Boolean({ default: true }),
          path: Type.Optional(Type.String()),
        }),
      ),
      confirmation: Type.Optional(
        Type.Object({
          enabled: Type.Boolean({ default: false }),
          tools: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
  ),

  github: Type.Optional(
    Type.Object({
      default_owner: Type.Optional(Type.String()),
      default_repo: Type.Optional(Type.String()),
    }),
  ),

  tasks: Type.Optional(
    Type.Object({
      enabled: Type.Boolean({ default: true }),
      tick_interval_ms: Type.Number({ default: 30000 }),
      max_active_tasks: Type.Number({ default: 20 }),
      task_timeout_ms: Type.Number({ default: 300000 }),
      discovery_enabled: Type.Boolean({ default: true }),
      discovery_interval_ms: Type.Number({ default: 1800000 }),
      idle_threshold_ms: Type.Number({ default: 600000 }),
      heartbeat: Type.Optional(
        Type.Object({
          enabled: Type.Boolean({ default: true }),
          schedule: Type.String({ default: '*/30 * * * *' }),
          business_hours: Type.Optional(Type.String()),
        }),
      ),
    }),
  ),

  transcript: Type.Optional(
    Type.Object({
      enabled: Type.Boolean({ default: true }),
      path: Type.Optional(Type.String()),
    }),
  ),

  tools: Type.Optional(
    Type.Object({
      files: Type.Boolean({ default: true }),
      exec: Type.Boolean({ default: true }),
      git: Type.Boolean({ default: true }),
      memory: Type.Boolean({ default: true }),
      browser: Type.Boolean({ default: false }),
      github: Type.Boolean({ default: false }),
      tasks: Type.Boolean({ default: false }),
      code_agent: Type.Boolean({ default: false }),
      web_research: Type.Boolean({ default: true }),
      screenshot: Type.Boolean({ default: true }),
    }),
  ),

  skills: Type.Object({
    dirs: Type.Array(Type.String(), { default: ['~/.egirl/skills', '{workspace}/skills'] }),
  }),
})

export type EgirlConfig = Static<typeof EgirlConfigSchema>

// Runtime config with resolved paths and secrets from .env
export interface RuntimeConfig {
  theme: string
  thinking: {
    level: ThinkingLevel
    budgetTokens?: number
    showThinking: boolean
  }
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
      apiKeys: string[]
      model: string
    }
    openai?: {
      apiKey: string
      apiKeys: string[]
      model: string
      baseUrl?: string
    }
  }
  routing: {
    default: 'local' | 'remote'
    escalationThreshold: number
    alwaysLocal: string[]
    alwaysRemote: string[]
    models: Record<string, string[]>
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
      apiKey?: string
      rateLimit: number
      maxRequestBytes: number
      corsOrigins: string[]
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
      mode: 'block' | 'allow'
      blockedPatterns: string[]
      extraAllowed: string[]
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
    heartbeat: {
      enabled: boolean
      schedule: string
      businessHours?: string
    }
  }
  transcript: {
    enabled: boolean
    path: string
  }
  tools: {
    files: boolean
    exec: boolean
    git: boolean
    memory: boolean
    browser: boolean
    github: boolean
    tasks: boolean
    codeAgent: boolean
    webResearch: boolean
    screenshot: boolean
  }
  skills: {
    dirs: string[]
  }
}
