import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { parse } from 'smol-toml'
import { setTheme } from '../ui/theme'
import type { EgirlConfig, RuntimeConfig, ThinkingLevel } from './schema'

export type { EgirlConfig, RuntimeConfig, ThinkingLevel } from './schema'

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

const defaultToml: EgirlConfig = {
  workspace: { path: '~/.egirl/workspace' },
  local: {
    endpoint: 'http://localhost:8080',
    model: 'qwen2.5-32b-instruct',
    context_length: 32768,
    max_concurrent: 2,
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
  const configPath = findConfigFile()
  const toml: EgirlConfig = configPath ? loadTomlConfig(configPath) : defaultToml

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
      codeAgentUsesClaudeCodeFallback: !toml.channels?.code_agent && !!toml.channels?.claude_code,
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
      endpoint: toml.local?.endpoint ?? defaultToml.local.endpoint,
      model: toml.local?.model ?? defaultToml.local.model,
      contextLength: toml.local?.context_length ?? defaultToml.local.context_length,
      maxConcurrent: toml.local?.max_concurrent ?? defaultToml.local.max_concurrent,
      staleStreamTimeoutMs: toml.local?.stale_stream_timeout_ms ?? 90000,
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
