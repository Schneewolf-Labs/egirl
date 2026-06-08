import { type Static, Type } from '@sinclair/typebox'

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

const CodeAgentChannelSchema = Type.Object({
  provider: Type.Union([Type.Literal('claude'), Type.Literal('codex')], {
    default: 'claude',
  }),
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
})

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
    stale_stream_timeout_ms: Type.Optional(Type.Number({ default: 90000 })),
    embeddings: Type.Optional(
      Type.Object({
        provider: Type.Optional(
          Type.Union([Type.Literal('qwen3-vl'), Type.Literal('llamacpp'), Type.Literal('openai')], {
            default: 'qwen3-vl',
          }),
        ),
        endpoint: Type.String({ default: 'http://localhost:8082' }),
        model: Type.String({ default: 'qwen3-vl-embedding-2b' }),
        dimensions: Type.Number({ default: 2048 }),
        multimodal: Type.Boolean({ default: true }),
        api_key: Type.Optional(Type.String()),
        base_url: Type.Optional(Type.String()),
      }),
    ),
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
          provider: Type.Optional(
            Type.Union([Type.Literal('claude'), Type.Literal('codex')], { default: 'claude' }),
          ),
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
      code_agent: Type.Optional(CodeAgentChannelSchema),
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
          host: Type.String({ default: '127.0.0.1' }),
          port: Type.Number({ default: 3000 }),
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
      permission_rules: Type.Optional(
        Type.Object({
          allow: Type.Array(Type.String(), { default: [] }),
          deny: Type.Array(Type.String(), { default: [] }),
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

  searxng: Type.Optional(
    Type.Object({
      url: Type.String(),
    }),
  ),

  energy: Type.Optional(
    Type.Object({
      enabled: Type.Boolean({ default: true }),
      max_energy: Type.Number({ default: 20 }),
      regen_per_hour: Type.Number({ default: 10 }),
    }),
  ),

  tasks: Type.Optional(
    Type.Object({
      enabled: Type.Boolean({ default: true }),
      tick_interval_ms: Type.Number({ default: 30000 }),
      max_active_tasks: Type.Number({ default: 20 }),
      max_concurrent_tasks: Type.Number({ default: 1 }),
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

  permission_supervisor: Type.Optional(
    Type.Object({
      mode: Type.Optional(
        Type.Union(
          [
            Type.Literal('bypass'),
            Type.Literal('supervised'),
            Type.Literal('rules_only'),
            Type.Literal('ask_user'),
          ],
          { default: 'supervised' },
        ),
      ),
      default_action: Type.Optional(
        Type.Union([Type.Literal('allow'), Type.Literal('deny'), Type.Literal('ask_user')], {
          default: 'allow',
        }),
      ),
      think_before_deciding: Type.Optional(Type.Boolean({ default: true })),
      min_confidence: Type.Optional(Type.Number({ default: 0.65 })),
      ask_user_below_confidence: Type.Optional(Type.Boolean({ default: false })),
      memory_recall: Type.Optional(Type.Boolean({ default: true })),
      memory_write: Type.Optional(Type.Boolean({ default: false })),
      policy: Type.Optional(
        Type.Object({
          allow: Type.Optional(Type.Array(Type.String())),
          deny: Type.Optional(Type.Array(Type.String())),
          ask_user: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
  ),

  tools: Type.Optional(
    Type.Object({
      files: Type.Boolean({ default: true }),
      exec: Type.Boolean({ default: true }),
      process: Type.Boolean({ default: false }),
      git: Type.Boolean({ default: true }),
      memory: Type.Boolean({ default: true }),
      browser: Type.Boolean({ default: false }),
      github: Type.Boolean({ default: false }),
      tasks: Type.Boolean({ default: false }),
      code_agent: Type.Boolean({ default: false }),
      web_research: Type.Boolean({ default: true }),
      web_search: Type.Boolean({ default: true }),
      screenshot: Type.Boolean({ default: true }),
    }),
  ),

  skills: Type.Object({
    dirs: Type.Array(Type.String(), { default: ['~/.egirl/skills', '{workspace}/skills'] }),
  }),

  defaults: Type.Optional(
    Type.Object({
      workspace_root: Type.Optional(Type.String()),
      profile: Type.Optional(Type.String()),
      persona: Type.Optional(Type.String()),
      instance: Type.Optional(Type.String()),
    }),
  ),

  profiles: Type.Optional(Type.Record(Type.String(), Type.Any())),
  personas: Type.Optional(Type.Record(Type.String(), Type.Any())),
  instances: Type.Optional(Type.Record(Type.String(), Type.Any())),
})

export type EgirlConfig = Static<typeof EgirlConfigSchema>

// Runtime config with resolved paths and secrets from .env
export interface RuntimeConfig {
  source: {
    path?: string
    instance?: string
    profile?: string
    persona?: string
    codeAgentUsesClaudeCodeFallback: boolean
  }
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
    staleStreamTimeoutMs: number
    embeddings?: {
      provider: 'qwen3-vl' | 'llamacpp' | 'openai'
      endpoint: string
      model: string
      dimensions: number
      multimodal: boolean
      apiKey?: string
      baseUrl?: string
    }
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
    codeAgent?: {
      provider?: 'claude' | 'codex'
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
      host: string
      port: number
      bearerToken?: string
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
    permissionRules: {
      allow: string[]
      deny: string[]
    }
  }
  github?: {
    token: string
    defaultOwner?: string
    defaultRepo?: string
  }
  searxng?: {
    url: string
    apiKey?: string
  }
  energy: {
    enabled: boolean
    maxEnergy: number
    regenPerHour: number
  }
  tasks: {
    enabled: boolean
    tickIntervalMs: number
    maxActiveTasks: number
    maxConcurrentTasks: number
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
  permissionSupervisor: {
    mode: 'bypass' | 'supervised' | 'rules_only' | 'ask_user'
    defaultAction: 'allow' | 'deny' | 'ask_user'
    thinkBeforeDeciding: boolean
    minConfidence: number
    askUserBelowConfidence: boolean
    memoryRecall: boolean
    memoryWrite: boolean
    policy: {
      allow: string[]
      deny: string[]
      askUser: string[]
    }
  }
  tools: {
    files: boolean
    exec: boolean
    process: boolean
    git: boolean
    memory: boolean
    browser: boolean
    github: boolean
    tasks: boolean
    codeAgent: boolean
    webResearch: boolean
    webSearch: boolean
    screenshot: boolean
  }
  skills: {
    dirs: string[]
  }
}
