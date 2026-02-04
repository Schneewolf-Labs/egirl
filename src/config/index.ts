import { Value } from '@sinclair/typebox/value'
import { EgirlConfigSchema, type EgirlConfig } from './schema'
import { defaultConfig } from './defaults'
import { resolve } from 'path'
import { homedir } from 'os'

export { EgirlConfigSchema, type EgirlConfig } from './schema'
export { defaultConfig } from './defaults'

function expandPath(path: string, workspaceDir?: string): string {
  let result = path.replace(/^~/, homedir())

  if (workspaceDir && result.includes('{workspace}')) {
    result = result.replace(/\{workspace\}/g, workspaceDir)
  }

  return result
}

function getEnvString(key: string, fallback?: string): string | undefined {
  return process.env[key] ?? fallback
}

function getEnvNumber(key: string, fallback?: number): number | undefined {
  const val = process.env[key]
  if (val === undefined) return fallback
  const num = parseFloat(val)
  return isNaN(num) ? fallback : num
}

function getEnvArray(key: string, fallback?: string[]): string[] | undefined {
  const val = process.env[key]
  if (val === undefined) return fallback
  return val.split(',').map(s => s.trim()).filter(Boolean)
}

export function loadConfig(overrides?: Partial<EgirlConfig>): EgirlConfig {
  // Build config from environment variables
  const envWorkspace = getEnvString('EGIRL_WORKSPACE')

  const envConfig = {
    local: {
      provider: (getEnvString('EGIRL_LOCAL_PROVIDER', 'llamacpp') as 'ollama' | 'llamacpp' | 'vllm'),
      endpoint: getEnvString('EGIRL_LOCAL_ENDPOINT', 'http://localhost:8080')!,
      model: getEnvString('EGIRL_LOCAL_MODEL', 'default')!,
      contextLength: getEnvNumber('EGIRL_LOCAL_CONTEXT_LENGTH', 8192)!,
      confidenceEstimation: getEnvString('EGIRL_LOCAL_CONFIDENCE_ESTIMATION') !== 'false',
    },
    remote: {
      ...(getEnvString('ANTHROPIC_API_KEY') && {
        anthropic: {
          apiKey: getEnvString('ANTHROPIC_API_KEY')!,
          defaultModel: getEnvString('ANTHROPIC_DEFAULT_MODEL', 'claude-sonnet-4-20250514')!,
        },
      }),
      ...(getEnvString('OPENAI_API_KEY') && {
        openai: {
          apiKey: getEnvString('OPENAI_API_KEY')!,
          defaultModel: getEnvString('OPENAI_DEFAULT_MODEL', 'gpt-4o')!,
        },
      }),
    },
    routing: {
      defaultModel: (getEnvString('EGIRL_DEFAULT_MODEL', 'local') as 'local' | 'remote'),
      escalationThreshold: getEnvNumber('EGIRL_ESCALATION_THRESHOLD', 0.4)!,
      alwaysLocal: getEnvArray('EGIRL_ALWAYS_LOCAL', ['memory_search', 'memory_get'])!,
      alwaysRemote: getEnvArray('EGIRL_ALWAYS_REMOTE', ['code_generation', 'code_review'])!,
    },
    channels: {
      ...(getEnvString('DISCORD_BOT_TOKEN') && {
        discord: {
          token: getEnvString('DISCORD_BOT_TOKEN')!,
          allowedUsers: getEnvArray('DISCORD_ALLOWED_USERS', [])!,
        },
      }),
    },
    skills: {
      directories: getEnvArray('EGIRL_SKILL_DIRECTORIES', ['~/.egirl/skills', '{workspace}/skills'])!,
    },
  }

  // Merge: defaults -> env -> overrides
  const merged = {
    ...defaultConfig,
    ...(envWorkspace && { workspace: envWorkspace }),
    ...overrides,
    local: { ...defaultConfig.local, ...envConfig.local, ...overrides?.local },
    remote: { ...defaultConfig.remote, ...envConfig.remote, ...overrides?.remote },
    routing: { ...defaultConfig.routing, ...envConfig.routing, ...overrides?.routing },
    channels: { ...defaultConfig.channels, ...envConfig.channels, ...overrides?.channels },
    skills: { ...defaultConfig.skills, ...envConfig.skills, ...overrides?.skills },
  }

  // Validate
  if (!Value.Check(EgirlConfigSchema, merged)) {
    const errors = [...Value.Errors(EgirlConfigSchema, merged)]
    throw new Error(`Invalid config: ${errors.map(e => `${e.path}: ${e.message}`).join(', ')}`)
  }

  // Expand paths
  merged.workspace = expandPath(merged.workspace)
  merged.skills.directories = merged.skills.directories.map(d =>
    expandPath(d, merged.workspace)
  )

  return merged
}

let _config: EgirlConfig | null = null

export function getConfig(): EgirlConfig {
  if (!_config) {
    _config = loadConfig()
  }
  return _config
}

export function setConfig(config: EgirlConfig): void {
  _config = config
}
