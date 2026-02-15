import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { parse } from 'smol-toml'
import { setTheme } from '../ui/theme'
import type { EgirlConfig, RuntimeConfig, ThinkingLevel } from './schema'

export type { EgirlConfig, RuntimeConfig, ThinkingLevel } from './schema'

function getDomain(service: string): string {
  try {
    const url = new URL(service)
    return url.hostname
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

/**
 * Collect API keys from environment variables.
 * Looks for BASE_KEY, BASE_KEY_2, BASE_KEY_3, etc.
 */
function collectApiKeys(baseEnvVar: string): string[] {
  const keys: string[] = []
  const primary = process.env[baseEnvVar]
  if (primary) keys.push(primary)

  // Check for numbered variants: _2, _3, ..., _10
  for (let i = 2; i <= 10; i++) {
    const key = process.env[`${baseEnvVar}_${i}`]
    if (key) keys.push(key)
  }

  return keys
}

function expandPath(path: string, workspaceDir?: string): string {
  let result = path.replace(/^~/, homedir())

  if (workspaceDir && result.includes('{workspace}')) {
    result = result.replace(/\{workspace\}/g, workspaceDir)
  }

  return resolve(result)
}

function findConfigFile(): string | null {
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

const defaultToml: EgirlConfig = {
  workspace: { path: '~/.egirl/workspace' },
  local: {
    endpoint: 'http://localhost:8080',
    model: 'qwen2.5-32b-instruct',
    context_length: 32768,
    max_concurrent: 2,
  },
  routing: {
    default: 'local',
    escalation_threshold: 0.4,
    always_local: ['memory_search', 'memory_get', 'greeting', 'acknowledgment'],
    always_remote: ['code_generation', 'code_review', 'complex_reasoning'],
  },
  conversation: {
    enabled: true,
    max_age_days: 30,
    max_messages: 1000,
    compact_on_startup: true,
    context_compaction: true,
  },
  skills: {
    dirs: ['~/.egirl/skills', '{workspace}/skills'],
  },
}

export function loadConfig(): RuntimeConfig {
  // Load TOML config
  const configPath = findConfigFile()
  const toml: EgirlConfig = configPath ? loadTomlConfig(configPath) : defaultToml

  // Resolve workspace path first (needed for other path expansions)
  const workspacePath = expandPath(toml.workspace?.path ?? defaultToml.workspace.path)

  // Create workspace directory if it doesn't exist
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true })
  }

  // Activate theme early so all subsequent output is themed
  const themeName = toml.theme ?? 'egirl'
  try {
    setTheme(themeName)
  } catch {
    // Falls back to default 'egirl' theme
  }

  // Build runtime config with snake_case from TOML mapped to camelCase
  const config: RuntimeConfig = {
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
      endpoint: toml.local?.endpoint ?? defaultToml.local.endpoint,
      model: toml.local?.model ?? defaultToml.local.model,
      contextLength: toml.local?.context_length ?? defaultToml.local.context_length,
      maxConcurrent: toml.local?.max_concurrent ?? defaultToml.local.max_concurrent,
      ...(toml.local?.embeddings && {
        embeddings: {
          endpoint: toml.local.embeddings.endpoint,
          model: toml.local.embeddings.model,
          dimensions: toml.local.embeddings.dimensions ?? 2048,
          multimodal: toml.local.embeddings.multimodal ?? true,
        },
      }),
    },
    remote: {},
    routing: {
      default: toml.routing?.default ?? defaultToml.routing.default,
      escalationThreshold:
        toml.routing?.escalation_threshold ?? defaultToml.routing.escalation_threshold,
      alwaysLocal: toml.routing?.always_local ?? defaultToml.routing.always_local,
      alwaysRemote: toml.routing?.always_remote ?? defaultToml.routing.always_remote,
      models: (toml.routing as Record<string, unknown>)?.models as Record<string, string[]> ?? {},
    },
    conversation: {
      enabled: toml.conversation?.enabled ?? true,
      maxAgeDays: toml.conversation?.max_age_days ?? 30,
      maxMessages: toml.conversation?.max_messages ?? 1000,
      compactOnStartup: toml.conversation?.compact_on_startup ?? true,
      contextCompaction: toml.conversation?.context_compaction ?? true,
    },
    channels: {},
    safety: {
      enabled: toml.safety?.enabled ?? true,
      commandFilter: {
        enabled: toml.safety?.command_filter?.enabled ?? true,
        blockedPatterns: toml.safety?.command_filter?.blocked_patterns ?? [],
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
    tasks: {
      enabled: toml.tasks?.enabled ?? true,
      tickIntervalMs: toml.tasks?.tick_interval_ms ?? 30000,
      maxActiveTasks: toml.tasks?.max_active_tasks ?? 20,
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
    skills: {
      dirs: (toml.skills?.dirs ?? defaultToml.skills.dirs).map((d) => expandPath(d, workspacePath)),
    },
  }

  // Load secrets from environment
  // Supports multiple keys: ANTHROPIC_API_KEY, ANTHROPIC_API_KEY_2, ANTHROPIC_API_KEY_3, etc.
  const anthropicKeys = collectApiKeys('ANTHROPIC_API_KEY')
  const openaiKeys = collectApiKeys('OPENAI_API_KEY')
  const discordToken = process.env.DISCORD_TOKEN

  if (anthropicKeys.length > 0) {
    const primaryKey = anthropicKeys[0] ?? ''
    config.remote.anthropic = {
      apiKey: primaryKey,
      apiKeys: anthropicKeys,
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
    }
  }

  if (openaiKeys.length > 0) {
    const primaryKey = openaiKeys[0] ?? ''
    config.remote.openai = {
      apiKey: primaryKey,
      apiKeys: openaiKeys,
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      ...(process.env.OPENAI_BASE_URL && { baseUrl: process.env.OPENAI_BASE_URL }),
    }
  }

  if (discordToken && toml.channels?.discord) {
    config.channels.discord = {
      token: discordToken,
      allowedChannels: toml.channels.discord.allowed_channels ?? ['dm'],
      allowedUsers: toml.channels.discord.allowed_users ?? [],
      passiveChannels: toml.channels.discord.passive_channels ?? [],
      batchWindowMs: toml.channels.discord.batch_window_ms ?? 3000,
    }
  }

  if (toml.channels?.claude_code) {
    const cc = toml.channels.claude_code
    config.channels.claudeCode = {
      permissionMode: cc.permission_mode ?? 'bypassPermissions',
      model: cc.model,
      workingDir: cc.working_dir ? expandPath(cc.working_dir, workspacePath) : process.cwd(),
      maxTurns: cc.max_turns,
    }
  }

  const xmppUsername = process.env.XMPP_USERNAME
  const xmppPassword = process.env.XMPP_PASSWORD

  if (xmppUsername && xmppPassword && toml.channels?.xmpp) {
    const xmppConf = toml.channels.xmpp
    const service = xmppConf.service ?? 'xmpp://localhost:5222'
    config.channels.xmpp = {
      service,
      domain: xmppConf.domain ?? getDomain(service),
      username: xmppUsername,
      password: xmppPassword,
      resource: xmppConf.resource,
      allowedJids: xmppConf.allowed_jids ?? [],
    }
  }

  if (toml.channels?.api) {
    config.channels.api = {
      port: toml.channels.api.port ?? 3000,
      host: toml.channels.api.host ?? '127.0.0.1',
    }
  }

  // GitHub integration
  const githubToken = process.env.GITHUB_TOKEN
  if (githubToken) {
    config.github = {
      token: githubToken,
      defaultOwner: toml.github?.default_owner,
      defaultRepo: toml.github?.default_repo,
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
