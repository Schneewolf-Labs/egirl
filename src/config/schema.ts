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

  // Who the human operating this instance is. Used to attribute a message they type into a
  // session that belongs to someone else -- a peer's thread, or a task's -- so the agent knows
  // a person is speaking and not the peer whose conversation it is.
  user: Type.Optional(Type.Object({ name: Type.Optional(Type.String()) })),

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
     * either on the way back, "qwen3"/"qwen35"/"laguna"/"deepseek" pin the model's native
     * syntax for both directions. Pinning matters when a model has a strong trained prior —
     * Laguna emits <arg_key>/<arg_value> regardless of what the prompt asks for, and DeepSeek
     * v4 falls back to its full-width <｜DSML｜tool_call> token under load.
     */
    tool_format: Type.String({ default: 'auto' }),
    /**
     * Prepend Qwen3's `/think` or `/no_think` soft-switch to the first user message. That
     * convention is specific to the Qwen3 chat template: on any other model the token is read
     * as text the user typed, and the model will react to it -- DeepSeek v4 reported being
     * asked "/think hey this is nick". Defaults on, because it is load-bearing for the Qwen3
     * models this was built against; turn it off for anything else.
     */
    thinking_directive: Type.Boolean({ default: true }),
    max_concurrent: Type.Number({ default: 2 }),
    /**
     * Abort a stream after this long with no new token. 90s aborted legitimate work on a
     * local model: a cold 32k prefill is minutes at ~29 tok/s, and time-to-first-token is
     * all prefill. Finite so a genuinely hung stream still fails.
     */
    stale_stream_timeout_ms: Type.Optional(Type.Number({ default: 300_000 })),
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    // Bearer token for a llama-server started with --api-key (a shared/keyed operator endpoint).
    // Prefer the EGIRL_LOCAL_API_KEY env var over putting the secret in the toml.
    api_key: Type.Optional(Type.String()),
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
      consolidation_interval: Type.Number({ default: 0 }),
    }),
  ),

  recovery: Type.Optional(
    Type.Object({
      continuation_retries: Type.Number({ default: 3 }),
      nudge_retries: Type.Number({ default: 3 }),
      empty_retries: Type.Number({ default: 2 }),
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

  // Consultant models for the consult tool: bigger-context OpenAI-compatible endpoints the
  // operator can ask for a read-only second opinion (no tool calling involved, which is
  // exactly why a model that is bad at our tool dialects can still be a great consultant).
  // API keys come from .env: EGIRL_CONSULTANT_<NAME>_KEY.
  consultants: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        endpoint: Type.String(),
        model: Type.String(),
        context_length: Type.Optional(Type.Number({ default: 131072 })),
        max_tokens: Type.Optional(Type.Number({ default: 8192 })),
        timeout_ms: Type.Optional(Type.Number({ default: 600_000 })),
        temperature: Type.Optional(Type.Number()),
      }),
    ),
  ),

  // Who this agent reports to (docs/autonomy-loop.md, Phase 2): "peer:<name>" for an agent
  // supervisor, or "<channel>:<target>" — e.g. "xmpp:you@example.com", "discord:<channelId>"
  // — for a human. The report tool is only registered when this is set.
  report: Type.Optional(
    Type.Object({
      to: Type.String(),
      // Default wait on a blocking ask before the agent is told to park and move on.
      ask_timeout_ms: Type.Number({ default: 1_800_000 }),
    }),
  ),

  // Resolve peers from a Wald agent registry rather than listing them here. Discovery
  // supplies addresses only -- tokens still come from EGIRL_PEER_<NAME>_TOKEN, because the
  // registry stores a reference to where a secret lives, never the secret.
  peer_discovery: Type.Optional(
    Type.Object({
      enabled: Type.Boolean({ default: false }),
      // MCP server name the registry is configured under, in [[mcp.servers]].
      registry: Type.Optional(Type.String({ default: 'wald' })),
      // How this instance announces itself; defaults to the selected instance name.
      self_name: Type.Optional(Type.String()),
      // This instance's own peer endpoint, so others can reach it. Without it the instance
      // discovers peers but does not publish itself.
      self_url: Type.Optional(Type.String()),
      capabilities: Type.Optional(Type.Array(Type.String())),
    }),
  ),

  // MCP servers whose tools are exposed to the agent. Either `command` (stdio, spawned) or
  // `url` (streamable HTTP). Tools are namespaced <server>_<tool> so two servers offering the
  // same tool name cannot shadow each other.
  mcp: Type.Optional(
    Type.Object({
      servers: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String(),
            command: Type.Optional(Type.String()),
            args: Type.Optional(Type.Array(Type.String())),
            env: Type.Optional(Type.Record(Type.String(), Type.String())),
            url: Type.Optional(Type.String()),
            headers: Type.Optional(Type.Record(Type.String(), Type.String())),
            timeout_ms: Type.Optional(Type.Number({ default: 30_000 })),
          }),
        ),
      ),
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
      // Post-run self-review for unbounded tasks: a restricted fork (skill/memory tools only)
      // reviews the run digest and patches skills / stores lessons autonomously.
      self_review: Type.Boolean({ default: true }),
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

  // Unified trace store: every turn (including thinking), full tool payloads, aux-model
  // work — SQLite in the workspace, FTS-searchable. Verbose by default: single-user disk
  // is cheap and post-mortems are not.
  tracing: Type.Optional(
    Type.Object({
      verbosity: Type.Union(
        [Type.Literal('off'), Type.Literal('metadata'), Type.Literal('verbose')],
        { default: 'verbose' },
      ),
      retention_days: Type.Number({ default: 14 }),
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
      consult: Type.Boolean({ default: true }),
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
    /** egirl.d/*.toml merged over the main config, in load order. */
    fragments?: string[]
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
    /** Whether to prepend Qwen3's /think soft-switch. Off for non-Qwen models. */
    thinkingDirective: boolean
    staleStreamTimeoutMs: number
    /** Sampling temperature. Undefined lets llama.cpp use its own default (0.8). */
    temperature?: number
    /** Bearer token for a keyed llama-server (--api-key). Undefined for the usual open server. */
    apiKey?: string
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
    /** Turns between consolidation-break nudges (0 = off). See docs/autonomy-loop.md. */
    consolidationInterval: number
  }
  /** Retry budgets for the agent loop's recovery rules. See src/agent/recovery.ts. */
  recovery?: {
    /** Continuations for a truncated (finish_reason: length) response. */
    continuationRetries: number
    /** Cap on each recovery nudge (stranded tool call, empty-after-tools). */
    nudgeRetries: number
    /** Silent retries for a with-no-tools empty response. */
    emptyRetries: number
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
  /** The human operating this instance, when named in config. */
  user?: { name?: string }
  peers?: Array<{
    name: string
    url: string
    token?: string
    timeoutMs: number
    /** Came from a registry rather than [[peers]] — see PeerEntry in src/peers/protocol.ts. */
    discovered?: boolean
  }>
  /** Read-only second-opinion models for the consult tool. */
  consultants?: Array<{
    name: string
    endpoint: string
    model: string
    contextLength: number
    maxTokens: number
    timeoutMs: number
    temperature?: number
    apiKey?: string
  }>
  /** Supervisor target for the report tool ("peer:<name>" or "<channel>:<target>"). */
  report?: {
    to: string
    askTimeoutMs: number
  }
  peerDiscovery?: {
    enabled: boolean
    registry?: string
    selfName?: string
    selfUrl?: string
    capabilities?: string[]
  }
  mcp?: {
    servers: Array<{
      name: string
      command?: string
      args?: string[]
      env?: Record<string, string>
      url?: string
      headers?: Record<string, string>
      timeoutMs?: number
    }>
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
    /** Post-run self-review pass for unbounded tasks. */
    selfReview: boolean
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
  tracing: {
    verbosity: 'off' | 'metadata' | 'verbose'
    retentionDays: number
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
    consult: boolean
    webResearch: boolean
    webSearch: boolean
    /** true/false = explicit; 'auto' (unset in toml) = only when the endpoint reports vision. */
    screenshot: boolean | 'auto'
  }
  skills: {
    dirs: string[]
  }
}
