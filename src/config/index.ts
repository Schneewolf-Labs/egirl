import { parse } from 'smol-toml'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import type { RuntimeConfig, EgirlConfig } from './schema'

export { type EgirlConfig, type RuntimeConfig } from './schema'

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

  // Build runtime config with snake_case from TOML mapped to camelCase
  const config: RuntimeConfig = {
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
        },
      }),
    },
    remote: {},
    routing: {
      default: toml.routing?.default ?? defaultToml.routing.default,
      escalationThreshold: toml.routing?.escalation_threshold ?? defaultToml.routing.escalation_threshold,
      alwaysLocal: toml.routing?.always_local ?? defaultToml.routing.always_local,
      alwaysRemote: toml.routing?.always_remote ?? defaultToml.routing.always_remote,
    },
    channels: {},
    skills: {
      dirs: (toml.skills?.dirs ?? defaultToml.skills.dirs).map(d => expandPath(d, workspacePath)),
    },
  }

  // Load secrets from environment
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY
  const discordToken = process.env.DISCORD_TOKEN

  if (anthropicKey) {
    config.remote.anthropic = {
      apiKey: anthropicKey,
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
    }
  }

  if (openaiKey) {
    config.remote.openai = {
      apiKey: openaiKey,
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
    }
  }

  if (discordToken && toml.channels?.discord) {
    config.channels.discord = {
      token: discordToken,
      allowedChannels: toml.channels.discord.allowed_channels ?? ['dm'],
      allowedUsers: toml.channels.discord.allowed_users ?? [],
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
