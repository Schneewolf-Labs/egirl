import type { TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { parse } from 'smol-toml'
import { peerTokenEnvKey } from '../peers/protocol'
import { setTheme } from '../ui/theme'
import { loadConfigFragments } from './fragments'
import {
  type CodeAgentProvider,
  ConfigFragmentSchema,
  type EgirlConfig,
  InstanceFragmentSchema,
  type RuntimeConfig,
  type ThinkingLevel,
} from './schema'

export type { EgirlConfig, RuntimeConfig, ThinkingLevel } from './schema'

export interface LoadConfigOptions {
  instance?: string
}

type ConfigFragment = Record<string, unknown>

function getXmppDomain(service: string): string {
  try {
    return new URL(service).hostname
  } catch {
    // Fallback: strip protocol and port
    return (
      service
        .replace(/^[a-z]+:\/\//, '')
        .split(':')[0]
        ?.split('/')[0] ?? service
    )
  }
}

function expandPath(path: string, workspaceDir?: string): string {
  let result = path.replace(/^~/, homedir())

  if (workspaceDir && result.includes('{workspace}')) {
    result = result.replace(/\{workspace\}/g, workspaceDir)
  }

  return resolve(result)
}

export function findConfigFile(): string | null {
  const candidates = [
    resolve(process.cwd(), 'egirl.toml'),
    resolve(homedir(), '.egirl', 'egirl.toml'),
    resolve(homedir(), '.config', 'egirl', 'egirl.toml'),
  ]

  for (const path of candidates) {
    if (existsSync(path)) return path
  }

  return null
}

function loadTomlConfig(path: string): EgirlConfig {
  const content = readFileSync(path, 'utf-8')
  return parse(content) as unknown as EgirlConfig
}

function isRecord(value: unknown): value is ConfigFragment {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge<T extends ConfigFragment>(base: T, ...overrides: unknown[]): T {
  const result: ConfigFragment = { ...base }

  for (const override of overrides) {
    if (!isRecord(override)) continue

    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue

      const existing = result[key]
      if (isRecord(existing) && isRecord(value)) {
        result[key] = deepMerge(existing, value)
      } else {
        result[key] = value
      }
    }
  }

  return result as T
}

/**
 * Substitute `$VAR` from the environment inside a string, anywhere it appears.
 *
 * The obvious shape for an auth header is `"Bearer $WALD_TOKEN"`, and matching only when the
 * whole value is `$VAR` sends that through verbatim — the server then rejects a token that
 * reads, literally, `Bearer $WALD_TOKEN`. That failure looks like a bad credential rather
 * than a config bug, which is a long way to walk for a missing substitution.
 *
 * An unset variable expands to empty rather than staying literal: a header that is visibly
 * missing its token fails immediately and legibly, where `$WALD_TOKEN` reaching the wire
 * invites the reader to think the value was somehow sent.
 */
export function expandEnvVars(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      v.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name) => process.env[name] ?? ''),
    ]),
  )
}

function stripCompositionSections(toml: EgirlConfig): ConfigFragment {
  const {
    defaults: _defaults,
    profiles: _profiles,
    personas: _personas,
    instances: _instances,
    ...rest
  } = toml as EgirlConfig & ConfigFragment
  return rest as ConfigFragment
}

function getNamedFragment(
  collection: unknown,
  name: string,
  label: string,
  schema: TSchema,
): ConfigFragment {
  if (!isRecord(collection)) {
    throw new Error(`Config references ${label} "${name}", but no [${label}s] are defined`)
  }

  const value = collection[name]
  if (!isRecord(value)) {
    throw new Error(`Config references unknown ${label} "${name}"`)
  }

  if (!Value.Check(schema, value)) {
    const [first] = [...Value.Errors(schema, value)]
    const detail = first ? `${first.path || '/'} ${first.message}` : 'invalid config'
    throw new Error(`Invalid ${label} "${name}": ${detail}`)
  }

  return value
}

function resolveTomlConfig(
  toml: EgirlConfig,
  options: LoadConfigOptions = {},
): {
  toml: EgirlConfig
  instance?: string
  profile?: string
  persona?: string
} {
  const defaults = isRecord(toml.defaults) ? toml.defaults : {}
  const selectedInstance =
    options.instance ?? (typeof defaults.instance === 'string' ? defaults.instance : undefined)
  const instance = selectedInstance
    ? getNamedFragment(toml.instances, selectedInstance, 'instance', InstanceFragmentSchema)
    : undefined

  const selectedProfile =
    (instance && typeof instance.profile === 'string' ? instance.profile : undefined) ??
    (typeof defaults.profile === 'string' ? defaults.profile : undefined)
  const selectedPersona =
    (instance && typeof instance.persona === 'string' ? instance.persona : undefined) ??
    (typeof defaults.persona === 'string' ? defaults.persona : undefined)

  const profile = selectedProfile
    ? getNamedFragment(toml.profiles, selectedProfile, 'profile', ConfigFragmentSchema)
    : undefined
  const persona = selectedPersona
    ? getNamedFragment(toml.personas, selectedPersona, 'persona', ConfigFragmentSchema)
    : undefined

  const workspaceRoot =
    typeof defaults.workspace_root === 'string' ? defaults.workspace_root : '~/.egirl'
  const personaWithWorkspace = persona
    ? deepMerge(
        {},
        typeof selectedPersona === 'string' && !persona.workspace
          ? { workspace: { path: `${workspaceRoot}/personas/${selectedPersona}` } }
          : {},
        persona,
      )
    : undefined

  const instanceFragment = instance ? { ...instance } : undefined
  if (instanceFragment) {
    delete instanceFragment.profile
    delete instanceFragment.persona
  }

  const merged = deepMerge(
    stripCompositionSections(toml),
    profile,
    personaWithWorkspace,
    instanceFragment,
  )

  return {
    toml: merged as unknown as EgirlConfig,
    instance: selectedInstance,
    profile: selectedProfile,
    persona: selectedPersona,
  }
}

const defaultToml: EgirlConfig = {
  workspace: { path: '~/.egirl/workspace' },
  local: {
    endpoint: 'http://localhost:8080',
    model: 'qwen2.5-32b-instruct',
    context_length: 32768,
    max_concurrent: 2,
    cache_slots: 1,
    tool_format: 'auto',
  },
  conversation: {
    enabled: true,
    max_age_days: 30,
    max_messages: 1000,
    compact_on_startup: true,
    context_compaction: true,
    consolidation_interval: 0,
  },
  skills: {
    dirs: ['~/.egirl/skills', '{workspace}/skills'],
  },
}

export function loadConfig(options: LoadConfigOptions = {}): RuntimeConfig {
  const configPath = findConfigFile()
  const baseToml: EgirlConfig = configPath ? loadTomlConfig(configPath) : defaultToml

  // Fragments merge over the base in filename order, so `egirl.d/zero.toml` can define an
  // instance without the main config being touched. Composition is by deep merge rather than
  // replacement: two fragments adding different instances both land, and a fragment overriding
  // one key of a profile leaves the rest of it alone.
  const fragments = configPath ? loadConfigFragments(configPath) : []
  const loadedToml = (
    fragments.length > 0
      ? deepMerge(baseToml as unknown as ConfigFragment, ...fragments.map((f) => f.toml))
      : baseToml
  ) as EgirlConfig

  const resolved = resolveTomlConfig(loadedToml, options)
  const toml = resolved.toml

  const workspacePath = expandPath(toml.workspace?.path ?? defaultToml.workspace.path)

  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true })
  }

  const themeName = toml.theme ?? 'egirl'
  try {
    setTheme(themeName)
  } catch {
    // Falls back to default 'egirl' theme
  }

  const config: RuntimeConfig = {
    source: {
      ...(configPath && { path: configPath }),
      ...(fragments.length > 0 && { fragments: fragments.map((fragment) => fragment.path) }),
      ...(resolved.instance && { instance: resolved.instance }),
      ...(resolved.profile && { profile: resolved.profile }),
      ...(resolved.persona && { persona: resolved.persona }),
      codeAgentUsesClaudeCodeFallback: !toml.channels?.code_agent && !!toml.channels?.claude_code,
      tasksConfiguredButGated: !!toml.tasks && !toml.tools?.tasks,
    },
    theme: themeName,
    thinking: {
      level: (toml.thinking?.level ?? 'off') as ThinkingLevel,
      budgetTokens: toml.thinking?.budget_tokens,
      showThinking: toml.thinking?.show_thinking ?? true,
    },
    workspace: {
      path: workspacePath,
    },
    local: {
      // EGIRL_LOCAL_ENDPOINT / EGIRL_LOCAL_MODEL point a single run at a different llama-server
      // without touching egirl.toml. That is what makes it possible to bench the same cases
      // against another machine — a 4090 running a Q4 quant, say — and compare the results,
      // rather than only ever measuring the box that happens to hold the config file.
      endpoint:
        process.env.EGIRL_LOCAL_ENDPOINT ?? toml.local?.endpoint ?? defaultToml.local.endpoint,
      model: process.env.EGIRL_LOCAL_MODEL ?? toml.local?.model ?? defaultToml.local.model,
      contextLength: toml.local?.context_length ?? defaultToml.local.context_length,
      maxConcurrent: toml.local?.max_concurrent ?? defaultToml.local.max_concurrent,
      cacheSlots: toml.local?.cache_slots ?? defaultToml.local.cache_slots ?? 1,
      toolFormat: toml.local?.tool_format ?? defaultToml.local.tool_format ?? 'auto',
      staleStreamTimeoutMs: toml.local?.stale_stream_timeout_ms ?? 300_000,
      // Undefined means "let the server decide", which is llama.cpp's 0.8. Set 0 to make runs
      // reproducible — see EGIRL_LOCAL_TEMPERATURE, which the bench uses.
      ...(process.env.EGIRL_LOCAL_TEMPERATURE !== undefined || toml.local?.temperature !== undefined
        ? {
            temperature:
              process.env.EGIRL_LOCAL_TEMPERATURE !== undefined
                ? Number(process.env.EGIRL_LOCAL_TEMPERATURE)
                : toml.local?.temperature,
          }
        : {}),
      ...(toml.local?.auxiliary && {
        auxiliary: {
          // Defaults to the main endpoint: the common setup is one llama-server holding both
          // models, or a second server on another port.
          endpoint:
            toml.local.auxiliary.endpoint ?? toml.local.endpoint ?? defaultToml.local.endpoint,
          model: toml.local.auxiliary.model,
          maxConcurrent: toml.local.auxiliary.max_concurrent,
          temperature: toml.local.auxiliary.temperature,
        },
      }),
      ...(toml.local?.embeddings && {
        embeddings: {
          provider: toml.local.embeddings.provider ?? 'qwen3-vl',
          endpoint: toml.local.embeddings.endpoint,
          model: toml.local.embeddings.model,
          dimensions: toml.local.embeddings.dimensions ?? 2048,
          multimodal: toml.local.embeddings.multimodal ?? true,
          apiKey: toml.local.embeddings.api_key,
          baseUrl: toml.local.embeddings.base_url,
        },
      }),
    },
    conversation: {
      enabled: toml.conversation?.enabled ?? true,
      maxAgeDays: toml.conversation?.max_age_days ?? 30,
      maxMessages: toml.conversation?.max_messages ?? 1000,
      compactOnStartup: toml.conversation?.compact_on_startup ?? true,
      contextCompaction: toml.conversation?.context_compaction ?? true,
      consolidationInterval: toml.conversation?.consolidation_interval ?? 0,
    },
    channels: {},
    safety: {
      enabled: toml.safety?.enabled ?? true,
      commandFilter: {
        enabled: toml.safety?.command_filter?.enabled ?? true,
        mode: (toml.safety?.command_filter?.mode as 'block' | 'allow') ?? 'block',
        blockedPatterns: toml.safety?.command_filter?.blocked_patterns ?? [],
        extraAllowed: toml.safety?.command_filter?.extra_allowed ?? [],
      },
      pathSandbox: {
        enabled: toml.safety?.path_sandbox?.enabled ?? true,
        allowedPaths: (toml.safety?.path_sandbox?.allowed_paths ?? [workspacePath]).map((p) =>
          expandPath(p, workspacePath),
        ),
      },
      sensitiveFiles: {
        enabled: toml.safety?.sensitive_files?.enabled ?? true,
        patterns: toml.safety?.sensitive_files?.patterns ?? [],
      },
      auditLog: {
        enabled: toml.safety?.audit_log?.enabled ?? true,
        path: toml.safety?.audit_log?.path
          ? expandPath(toml.safety.audit_log.path, workspacePath)
          : undefined,
      },
      confirmation: {
        enabled: toml.safety?.confirmation?.enabled ?? false,
        tools: toml.safety?.confirmation?.tools ?? ['execute_command', 'write_file', 'edit_file'],
      },
      permissionRules: {
        allow: toml.safety?.permission_rules?.allow ?? [],
        deny: toml.safety?.permission_rules?.deny ?? [],
      },
    },
    memory: {
      proactiveRetrieval: toml.memory?.proactive_retrieval ?? true,
      scoreThreshold: toml.memory?.score_threshold ?? 0.35,
      maxResults: toml.memory?.max_results ?? 5,
      maxTokensBudget: toml.memory?.max_tokens_budget ?? 2000,
      autoExtract: toml.memory?.auto_extract ?? true,
      extractionMinMessages: toml.memory?.extraction_min_messages ?? 2,
      extractionMaxPerTurn: toml.memory?.extraction_max_per_turn ?? 5,
    },
    energy: {
      enabled: toml.energy?.enabled ?? true,
      maxEnergy: toml.energy?.max_energy ?? 20,
      regenPerHour: toml.energy?.regen_per_hour ?? 10,
    },
    tasks: {
      enabled: toml.tasks?.enabled ?? true,
      tickIntervalMs: toml.tasks?.tick_interval_ms ?? 30000,
      maxActiveTasks: toml.tasks?.max_active_tasks ?? 20,
      maxConcurrentTasks: toml.tasks?.max_concurrent_tasks ?? 1,
      taskTimeoutMs: toml.tasks?.task_timeout_ms ?? 300000,
      discoveryEnabled: toml.tasks?.discovery_enabled ?? true,
      discoveryIntervalMs: toml.tasks?.discovery_interval_ms ?? 1800000,
      idleThresholdMs: toml.tasks?.idle_threshold_ms ?? 600000,
      heartbeat: {
        enabled: toml.tasks?.heartbeat?.enabled ?? true,
        schedule: toml.tasks?.heartbeat?.schedule ?? '*/30 * * * *',
        businessHours: toml.tasks?.heartbeat?.business_hours,
      },
    },
    transcript: {
      enabled: toml.transcript?.enabled ?? true,
      path: toml.transcript?.path
        ? expandPath(toml.transcript.path, workspacePath)
        : join(workspacePath, 'transcripts'),
    },
    permissionSupervisor: {
      mode: toml.permission_supervisor?.mode ?? 'supervised',
      defaultAction: toml.permission_supervisor?.default_action ?? 'allow',
      thinkBeforeDeciding: toml.permission_supervisor?.think_before_deciding ?? true,
      minConfidence: toml.permission_supervisor?.min_confidence ?? 0.65,
      askUserBelowConfidence: toml.permission_supervisor?.ask_user_below_confidence ?? false,
      memoryRecall: toml.permission_supervisor?.memory_recall ?? true,
      memoryWrite: toml.permission_supervisor?.memory_write ?? false,
      policy: {
        allow: toml.permission_supervisor?.policy?.allow ?? [],
        deny: toml.permission_supervisor?.policy?.deny ?? [],
        askUser: toml.permission_supervisor?.policy?.ask_user ?? [],
      },
    },
    tools: {
      files: toml.tools?.files ?? true,
      exec: toml.tools?.exec ?? true,
      process: toml.tools?.process ?? false,
      git: toml.tools?.git ?? true,
      memory: toml.tools?.memory ?? true,
      browser: toml.tools?.browser ?? false,
      github: toml.tools?.github ?? false,
      tasks: toml.tools?.tasks ?? false,
      codeAgent: toml.tools?.code_agent ?? false,
      peers: toml.tools?.peers ?? true,
      webResearch: toml.tools?.web_research ?? true,
      webSearch: toml.tools?.web_search ?? true,
      screenshot: toml.tools?.screenshot ?? true,
    },
    skills: {
      dirs: (toml.skills?.dirs ?? defaultToml.skills.dirs).map((d) => expandPath(d, workspacePath)),
    },
  }

  const discordToken = process.env.DISCORD_TOKEN

  if (discordToken && toml.channels?.discord) {
    config.channels.discord = {
      token: discordToken,
      allowedChannels: toml.channels.discord.allowed_channels ?? ['dm'],
      allowedUsers: toml.channels.discord.allowed_users ?? [],
      passiveChannels: toml.channels.discord.passive_channels ?? [],
      batchWindowMs: toml.channels.discord.batch_window_ms ?? 3000,
    }
  }

  const xmppUsername = process.env.XMPP_USERNAME
  const xmppPassword = process.env.XMPP_PASSWORD

  if (xmppUsername && xmppPassword && toml.channels?.xmpp) {
    const xmppConf = toml.channels.xmpp
    const service = xmppConf.service ?? 'xmpp://localhost:5222'
    config.channels.xmpp = {
      service,
      domain: xmppConf.domain ?? getXmppDomain(service),
      username: xmppUsername,
      password: xmppPassword,
      resource: xmppConf.resource,
      allowedJids: xmppConf.allowed_jids ?? [],
    }
  }

  if (toml.channels?.api) {
    const bearerToken = process.env.EGIRL_API_TOKEN
    config.channels.api = {
      host: toml.channels.api.host ?? '127.0.0.1',
      port: toml.channels.api.port ?? 3000,
      ...(bearerToken && { bearerToken }),
    }
  }

  if (toml.channels?.claude_code) {
    const cc = toml.channels.claude_code
    config.channels.claudeCode = {
      permissionMode: cc.permission_mode ?? 'bypassPermissions',
      model: cc.model,
      workingDir: cc.working_dir ? expandPath(cc.working_dir, workspacePath) : workspacePath,
      maxTurns: cc.max_turns,
    }
  }

  const codeAgentChannel = toml.channels?.code_agent ?? toml.channels?.claude_code
  if (codeAgentChannel) {
    const cc = codeAgentChannel
    config.channels.codeAgent = {
      provider: cc.provider ?? 'claude',
      // `claude_code` is the legacy alias for this channel and has no providers list.
      providers: 'providers' in cc ? (cc.providers as CodeAgentProvider[] | undefined) : undefined,
      permissionMode: cc.permission_mode ?? 'bypassPermissions',
      model: cc.model,
      workingDir: cc.working_dir ? expandPath(cc.working_dir, workspacePath) : workspacePath,
      maxTurns: cc.max_turns,
    }
  }

  const githubToken = process.env.GITHUB_TOKEN
  if (githubToken) {
    config.github = {
      token: githubToken,
      defaultOwner: toml.github?.default_owner,
      defaultRepo: toml.github?.default_repo,
    }
  }

  if (toml.searxng?.url) {
    const searxngApiKey = process.env.SEARXNG_API_KEY
    config.searxng = {
      url: toml.searxng.url,
      ...(searxngApiKey && { apiKey: searxngApiKey }),
    }
  }

  if (toml.peers && toml.peers.length > 0) {
    config.peers = toml.peers.map((p) => {
      const token = process.env[peerTokenEnvKey(p.name)]
      return {
        name: p.name,
        url: p.url.replace(/\/+$/, ''),
        ...(token && { token }),
        timeoutMs: p.timeout_ms ?? 120_000,
      }
    })
  }

  if (toml.peer_discovery?.enabled) {
    config.peerDiscovery = {
      enabled: true,
      ...(toml.peer_discovery.registry && { registry: toml.peer_discovery.registry }),
      ...(toml.peer_discovery.self_name && { selfName: toml.peer_discovery.self_name }),
      ...(toml.peer_discovery.self_url && { selfUrl: toml.peer_discovery.self_url }),
      ...(toml.peer_discovery.capabilities && {
        capabilities: toml.peer_discovery.capabilities,
      }),
    }
  }

  if (toml.mcp?.servers && toml.mcp.servers.length > 0) {
    config.mcp = {
      servers: toml.mcp.servers.map((m) => ({
        name: m.name,
        ...(m.command && { command: m.command }),
        ...(m.args && { args: m.args }),
        // $VAR is read from the environment, so a token lives in .env rather than in a config
        // file that gets committed.
        ...(m.env && { env: expandEnvVars(m.env) }),
        ...(m.url && { url: m.url }),
        ...(m.headers && { headers: expandEnvVars(m.headers) }),
        timeoutMs: m.timeout_ms ?? 30_000,
      })),
    }
  }

  return config
}

let _config: RuntimeConfig | null = null

export function getConfig(): RuntimeConfig {
  if (!_config) {
    _config = loadConfig()
  }
  return _config
}

export function setConfig(config: RuntimeConfig): void {
  _config = config
}
