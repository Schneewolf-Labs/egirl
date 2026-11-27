import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { colors, DIM, RESET } from '../ui/theme'

interface InitOptions {
  force: boolean
  provider: 'claude' | 'codex' | 'opencode'
  endpoint: string
  workspace: string
}

function parseOptions(args: string[]): InitOptions {
  const options: InitOptions = {
    force: false,
    provider: 'codex',
    endpoint: 'http://localhost:8080',
    workspace: '~/.egirl/workspace',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--force' || arg === '-f') {
      options.force = true
      continue
    }

    if (arg === '--provider') {
      const value = args[++i]
      if (value !== 'claude' && value !== 'codex' && value !== 'opencode') {
        throw new Error('--provider must be "claude", "codex", or "opencode"')
      }
      options.provider = value
      continue
    }

    if (arg === '--endpoint') {
      const value = args[++i]
      if (!value) throw new Error('--endpoint requires a URL')
      options.endpoint = value
      continue
    }

    if (arg === '--workspace') {
      const value = args[++i]
      if (!value) throw new Error('--workspace requires a path')
      options.workspace = value
      continue
    }

    throw new Error(`Unknown init option: ${arg}`)
  }

  return options
}

function renderToml(options: InitOptions): string {
  const model = options.provider === 'codex' ? 'qwen3-vl-32b' : 'qwen2.5-32b-instruct'

  return `# egirl needs one operator model ([local] below). Everything commented out is optional:
# docs/optional-services.md. From zero to a first turn: docs/getting-started.md.

# CLI color theme: egirl (purple/pink), midnight, neon, mono, dracula, nord, gruvbox, catppuccin,
# solarized, tokyonight, sakura, synthwave, paper (light backgrounds), ... -- /theme lists them all
theme = "egirl"

[thinking]
level = "off"
show_thinking = true

[workspace]
path = ${JSON.stringify(options.workspace)}

[local]
endpoint = ${JSON.stringify(options.endpoint)}
model = "${model}"
context_length = 32768
max_concurrent = 2

# Optional: embeddings add recall by meaning. Without them memory uses keyword search.
# Pick one (docs/optional-services.md#embeddings).
# A. nomic-embed-text-v1.5 on llama-server, CPU, 768 dimensions:
# [local.embeddings]
# provider = "llamacpp"
# endpoint = "http://127.0.0.1:8083"
# model = "nomic-embed-text-v1.5"
# dimensions = 768
# multimodal = false
# B. services/embeddings (Qwen3-VL-Embedding-2B, Python), 2048 dimensions:
# [local.embeddings]
# provider = "qwen3-vl"
# endpoint = "http://localhost:8082"
# model = "qwen3-vl-embedding-2b"
# dimensions = 2048
# multimodal = true

# The code agent (--provider). Optional; docs/optional-services.md#code-agent.
[channels.code_agent]
provider = "${options.provider}"
permission_mode = "default"
# model = "sonnet"        # Claude example
# model = "gpt-5.5"       # Codex example
# model = "anthropic/claude-sonnet-4-5"  # opencode example
# working_dir = "~/projects/myrepo"
# max_turns = 30          # Claude backend only

# Direct Claude Code bridge command only: bun run start cc
# [channels.claude_code]
# permission_mode = "bypassPermissions"
# model = "sonnet"

# [channels.discord]
# allowed_channels = ["dm"]
# allowed_users = []

# [channels.api]
# host = "127.0.0.1"
# port = 3000

[safety]
enabled = true

[safety.command_filter]
enabled = true

[safety.path_sandbox]
enabled = false
# allowed_paths = ["{workspace}", "~/projects"]

[safety.sensitive_files]
enabled = true

[safety.audit_log]
enabled = true
path = "{workspace}/audit.log"

[tools]
code_agent = true
github = false
tasks = false
browser = false

[skills]
dirs = ["~/.egirl/skills", "{workspace}/skills"]
`
}

function envTemplate(): string {
  try {
    return readFileSync(join(process.cwd(), '.env.example'), 'utf-8')
  } catch {
    return `# Secrets only - config goes in egirl.toml
DISCORD_TOKEN=
XMPP_USERNAME=
XMPP_PASSWORD=
TELEGRAM_BOT_TOKEN=
MATRIX_ACCESS_TOKEN=
MATRIX_USERNAME=
MATRIX_PASSWORD=
EGIRL_API_TOKEN=
GITHUB_TOKEN=
SEARXNG_API_KEY=
`
  }
}

export async function runInit(args: string[]): Promise<void> {
  const c = colors()
  const options = parseOptions(args)

  const configPath = join(process.cwd(), 'egirl.toml')
  const envPath = join(process.cwd(), '.env')

  if (existsSync(configPath) && !options.force) {
    console.log(
      `${c.warning}skip${RESET} egirl.toml already exists ${DIM}(use --force to replace)${RESET}`,
    )
  } else {
    writeFileSync(configPath, renderToml(options))
    console.log(`${c.success}write${RESET} egirl.toml ${DIM}(${options.provider})${RESET}`)
  }

  if (existsSync(envPath) && !options.force) {
    console.log(
      `${c.warning}skip${RESET} .env already exists ${DIM}(use --force to replace)${RESET}`,
    )
  } else {
    writeFileSync(envPath, envTemplate())
    console.log(`${c.success}write${RESET} .env`)
  }

  console.log(`\n${c.primary}Next${RESET}`)
  console.log(`  bun run start doctor`)
  console.log(`  bun run start cli`)
}
