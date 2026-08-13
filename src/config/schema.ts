import { type Static, type TSchema, Type } from '@sinclair/typebox'

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

// Single source of truth for code-agent backends. A new literal here flows
// into the config schema and the dispatch map.
export const CODE_AGENT_PROVIDERS = ['claude', 'codex', 'opencode'] as const
export type CodeAgentProvider = (typeof CODE_AGENT_PROVIDERS)[number]

const codeAgentProviderSchema = Type.Union(
  CODE_AGENT_PROVIDERS.map((value) => Type.Literal(value)),
  { default: 'claude' },
)

// Recursively makes every object field optional and forbids unknown keys, so a
// config fragment can override any subset of the real schema while typos throw.
function deepPartial(schema: TSchema): TSchema {
  if (schema.type === 'object' && 'properties' in schema && schema.properties) {
    const properties: Record<string, TSchema> = {}
    for (const [key, value] of Object.entries(schema.properties as Record<string, TSchema>)) {
      properties[key] = Type.Optional(deepPartial(value))
    }
    return Type.Object(properties, { additionalProperties: false })
  }
  return schema
}

const CodeAgentChannelSchema = Type.Object({
  provider: codeAgentProviderSchema,
  // Ordered fallback chain. When a backend cannot run the task at all — missing binary, expired
  // credentials, exhausted credits, an empty transcript — the next one is tried. An agent that
  // ran and reported failure is *not* retried; see shouldFailover.
  providers: Type.Optional(Type.Array(codeAgentProviderSchema)),
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

const baseProperties = {
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
    /**
     * KV cache slots the local server exposes (sabrewing --kv-slots). Sessions are
     * pinned to a slot so the server can reuse each conversation's already-prefilled
     * prefix. 1 = every session shares slot 0, which makes concurrent conversations
     * evict each other; 0 disables slot pinning entirely.
     */
    cache_slots: Type.Number({ default: 1 }),
    /**
     * Tool-calling dialect the local model speaks: "auto" asks in Qwen3 form and accepts
     * either on the way back, "qwen3"/"laguna" pin the model's native syntax for both
     * directions. Pinning matters when a model has a strong trained prior — Laguna emits
     * <arg_key>/<arg_value> regardless of what the prompt asks for.
     */
    tool_format: Type.String({ default: 'auto' }),
    max_concurrent: Type.Number({ default: 2 }),
    /**
     * Abort a stream after this long with no new token. 90s aborted legitimate work on a
     * local model: a cold 32k prefill is minutes at ~29 tok/s, and time-to-first-token is
     * all prefill. Finite so a genuinely hung stream still fails.
     */
    stale_stream_timeout_ms: Type.Optional(Type.Number({ default: 300_000 })),
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    // A second, usually smaller model for side work: compaction summaries, memory extraction.
    // These run on every compaction and every few turns, and they do not need the operator
    // model's capability — but they do occupy its slot and its context while they run.
    auxiliary: Type.Optional(
      Type.Object({
        endpoint: Type.Optional(Type.String()),
        model: Type.String(),
        max_concurrent: Type.Optional(Type.Number({ minimum: 1 })),
        temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
      }),
    ),
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
          provider: Type.Optional(codeAgentProviderSchema),
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

  // Other egirl instances this one can message over the egirl-peer HTTP
  // protocol (see docs/peers.md). Bearer tokens come from .env, not here:
  // EGIRL_PEER_<NAME>_TOKEN must hold the peer's EGIRL_API_TOKEN.
  peers: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        url: Type.String(),
        timeout_ms: Type.Optional(Type.Number({ default: 120_000 })),
      }),
    ),
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
      peers: Type.Boolean({ default: true }),
      web_research: Type.Boolean({ default: true }),
      web_search: Type.Boolean({ default: true }),
      screenshot: Type.Boolean({ default: true }),
    }),
  ),

  skills: Type.Object({
    dirs: Type.Array(Type.String(), { default: ['~/.egirl/skills', '{workspace}/skills'] }),
  }),
}

const BaseConfigSchema = Type.Object(baseProperties)

// Profiles, personas, and instances reuse the top-level config shape — every
// field optional, unknown keys rejected. There is no separate flat syntax.
export const ConfigFragmentSchema = deepPartial(BaseConfigSchema)
export const InstanceFragmentSchema = deepPartial(
  Type.Object({
    ...baseProperties,
    profile: Type.Optional(Type.String()),
    persona: Type.Optional(Type.String()),
  }),
)

export const EgirlConfigSchema = Type.Object({
  ...baseProperties,

  defaults: Type.Optional(
    Type.Object({
      workspace_root: Type.Optional(Type.String()),
      profile: Type.Optional(Type.String()),
      persona: Type.Optional(Type.String()),
      instance: Type.Optional(Type.String()),
    }),
  ),

  profiles: Type.Optional(Type.Record(Type.String(), ConfigFragmentSchema)),
  personas: Type.Optional(Type.Record(Type.String(), ConfigFragmentSchema)),
  instances: Type.Optional(Type.Record(Type.String(), InstanceFragmentSchema)),
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
    /** the user wrote a [tasks] section but [tools] tasks is false, so all of it is inert */
    tasksConfiguredButGated: boolean
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
    cacheSlots: number
    toolFormat: string
    staleStreamTimeoutMs: number
    /** Sampling temperature. Undefined lets llama.cpp use its own default (0.8). */
    temperature?: number
    /** Optional smaller model for summarisation and memory extraction. */
    auxiliary?: {
      endpoint: string
      model: string
      maxConcurrent?: number
      temperature?: number
    }
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
      provider?: CodeAgentProvider
      providers?: CodeAgentProvider[]
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
  peers?: Array<{
    name: string
    url: string
    token?: string
    timeoutMs: number
  }>
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
    peers: boolean
    webResearch: boolean
    webSearch: boolean
    screenshot: boolean
  }
  skills: {
    dirs: string[]
  }
}
