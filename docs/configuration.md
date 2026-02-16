# Configuration Reference

egirl is configured through two files: `egirl.toml` for application settings and `.env` for secrets.

## egirl.toml

### Top-level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `theme` | string | `"egirl"` | CLI color theme. Options: `"egirl"` (purple/pink), `"midnight"` (blue/teal), `"neon"` (green/cyan), `"mono"` (grayscale) |

### `[thinking]`

Controls extended thinking / reasoning for Anthropic (extended thinking) and Qwen3 (`/think` mode).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `level` | `"off"` \| `"low"` \| `"medium"` \| `"high"` | `"off"` | Thinking level. Higher levels allocate more tokens for reasoning |
| `budget_tokens` | number | (auto from level) | Override the thinking token budget directly |
| `show_thinking` | bool | `true` | Display thinking output in CLI |

Override per-session in CLI with: `/think <level>`

### `[workspace]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `path` | string | `~/.egirl/workspace` | Directory for personality files, memory database, logs, and skills. Tilde (`~`) is expanded to the user's home directory. |

The workspace directory is created automatically on first run and populated with default templates (IDENTITY.md, SOUL.md, AGENTS.md, USER.md, MEMORY.md, TOOLS.md).

### `[local]`

Settings for the local llama.cpp server.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `endpoint` | string | `http://localhost:8080` | URL of the llama.cpp HTTP server |
| `model` | string | `qwen2.5-32b-instruct` | Model name (for display/logging only — the server decides which model to load) |
| `context_length` | number | `32768` | Maximum context window in tokens. Should match your llama.cpp server's `-c` flag |
| `max_concurrent` | number | `2` | Maximum concurrent requests to the local server |

### `[local.embeddings]`

Optional. If omitted, the memory system is disabled entirely.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `endpoint` | string | `http://localhost:8082` | URL of the embedding server (llama.cpp with `--embedding` flag, or the Python service in `services/embeddings/`) |
| `model` | string | `qwen3-vl-embedding-2b` | Embedding model name (for logging) |
| `dimensions` | number | `2048` | Embedding vector dimensions. Must match the model's output |
| `multimodal` | boolean | `true` | Whether the embedding model supports image inputs (e.g., Qwen3-VL-Embedding) |

### `[routing]`

Controls how requests are distributed between local and remote providers.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `default` | `"local"` \| `"remote"` | `"local"` | Default routing target when no rules match |
| `escalation_threshold` | number | `0.4` | Confidence score below which local responses trigger escalation to remote (0.0–1.0) |
| `always_local` | string[] | `["memory_search", "memory_get", "greeting", "acknowledgment"]` | Task types that always route to the local model |
| `always_remote` | string[] | `["code_generation", "code_review", "complex_reasoning"]` | Task types that always route to the remote model |

**Task types** recognized by the router:
- `conversation` — general chat
- `tool_use` — file operations, command execution
- `code_generation` — writing or modifying code
- `reasoning` — analysis, explanations
- `memory_op` — memory search/recall
- `greeting` — hi, hello, etc.
- `acknowledgment` — thanks, ok, etc.

### `[channels.discord]`

Optional. Required only when running `bun run start discord`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `allowed_channels` | string[] | `["dm"]` | Channel IDs where the bot responds. Use `"dm"` for direct messages, or paste numeric channel IDs |
| `allowed_users` | string[] | `[]` | User IDs allowed to interact. Empty array means all users are allowed |

The Discord token itself goes in `.env` (see below).

### `[channels.claude_code]`

Optional. Settings for the Claude Code bridge mode.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `permission_mode` | string | `"bypassPermissions"` | How Claude Code handles tool permissions. See values below |
| `model` | string | (none) | Override the Claude model used (e.g., `"claude-sonnet-4-20250514"`) |
| `working_dir` | string | current directory | Working directory for Claude Code operations |
| `max_turns` | number | (none) | Maximum agentic turns before stopping |

**Permission modes:**
- `"default"` — Claude Code asks for permission on each tool use; local model answers
- `"acceptEdits"` — Auto-approve file edits, ask about everything else
- `"bypassPermissions"` — Skip all permission prompts (trust Claude Code)
- `"plan"` — Claude Code creates a plan before executing

### `[channels.xmpp]`

Optional. Required only when running `bun run start xmpp`. XMPP credentials (`XMPP_USERNAME`, `XMPP_PASSWORD`) must be set in `.env`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `service` | string | `xmpp://localhost:5222` | XMPP server URI. Use `xmpps://` for direct TLS |
| `domain` | string | (derived from service) | XMPP domain (e.g., `example.com`). Defaults to the hostname from `service` |
| `resource` | string | `egirl` | XMPP resource identifier |
| `allowed_jids` | string[] | `[]` | Bare JIDs allowed to message (e.g., `["user@example.com"]`). Empty array means all JIDs are allowed |

### `[channels.api]`

Optional. Required only when running `bun run start api`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `port` | number | `3000` | Port for the HTTP API server |
| `host` | string | `127.0.0.1` | Bind address. Use `0.0.0.0` to listen on all interfaces |

### `[safety]`

Master switch and per-feature toggles for the safety layer. See [docs/safety.md](safety.md) for the full guide.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Master switch for all safety features |

#### `[safety.command_filter]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Block dangerous shell commands (`rm -rf /`, fork bombs, etc.) |
| `blocked_patterns` | string[] | `[]` | Additional regex patterns appended to the built-in blocklist |

#### `[safety.path_sandbox]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `false` | Restrict file operations to allowed directories |
| `allowed_paths` | string[] | `[]` | Directories file ops are restricted to. Supports `{workspace}` and `~` |

#### `[safety.sensitive_files]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Block access to sensitive files (`.env`, SSH keys, credentials) |
| `patterns` | string[] | `[]` | Additional regex patterns appended to the built-in list |

#### `[safety.audit_log]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Log all tool calls (including blocked ones) to a JSONL file |
| `path` | string | — | Path to the audit log file. Supports `{workspace}` |

#### `[safety.confirmation]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `false` | Require confirmation before executing destructive tools |
| `tools` | string[] | `["execute_command", "write_file", "edit_file"]` | Tools that require confirmation |

### `[github]`

Optional. Configures defaults for the GitHub tools. The `GITHUB_TOKEN` environment variable must be set for GitHub tools to work.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `default_owner` | string | (auto-detected from git remote) | Default repository owner for GitHub API calls |
| `default_repo` | string | (auto-detected from git remote) | Default repository name for GitHub API calls |

### `[tasks]`

Optional. Configures the [background task framework](background-tasks.md).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Enable background task system |
| `tick_interval_ms` | number | `30000` | How often to check for due scheduled tasks (ms) |
| `max_active_tasks` | number | `20` | Maximum number of active tasks at once |
| `task_timeout_ms` | number | `300000` | Maximum duration per task run (5 min default) |
| `discovery_enabled` | bool | `true` | Agent looks for useful work during idle time |
| `discovery_interval_ms` | number | `1800000` | Time between discovery runs (30 min default) |
| `idle_threshold_ms` | number | `600000` | Idle time before discovery kicks in (10 min default) |

#### `[tasks.heartbeat]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Enable periodic heartbeat task |
| `schedule` | string | `"*/30 * * * *"` | Cron expression for heartbeat frequency |
| `business_hours` | string | (none) | Restrict heartbeat to hours, e.g. `"9-17 Mon-Fri"` |

### `[transcript]`

Optional. Configures conversation transcript logging.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Log conversations to JSONL files |
| `path` | string | (workspace default) | Path to the transcript log file. Supports `{workspace}` |

### `[skills]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `dirs` | string[] | `["~/.egirl/skills", "{workspace}/skills"]` | Directories to scan for skill files. `{workspace}` is replaced with the workspace path |

## .env

Create from the template: `cp .env.example .env`

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | No | Anthropic API key for Claude (escalation provider) |
| `OPENAI_API_KEY` | No | OpenAI API key (fallback escalation provider) |
| `DISCORD_TOKEN` | For Discord mode | Discord bot token |
| `GITHUB_TOKEN` | For GitHub tools | GitHub personal access token (for PR, issue, CI tools) |
| `XMPP_USERNAME` | For XMPP mode | XMPP account username (local part, without domain) |
| `XMPP_PASSWORD` | For XMPP mode | XMPP account password |

If neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` is set, all requests route to the local model regardless of routing rules. The agent will log a warning but function normally.

## Remote Provider Priority

When both API keys are set:
1. **Anthropic** is used as the primary remote provider
2. **OpenAI** is the fallback if Anthropic is not configured

This priority is hardcoded in `src/providers/index.ts`.

## Full Example

```toml
# egirl.toml
theme = "egirl"

[thinking]
level = "off"
show_thinking = true

[workspace]
path = "~/.egirl/workspace"

[local]
endpoint = "http://localhost:8080"
model = "qwen3-vl-32b"
context_length = 32768
max_concurrent = 2

[local.embeddings]
endpoint = "http://localhost:8082"
model = "qwen3-vl-embedding-2b"
dimensions = 2048
multimodal = true

[routing]
default = "local"
escalation_threshold = 0.4
always_local = ["memory_search", "memory_get", "greeting", "acknowledgment"]
always_remote = ["code_generation", "code_review", "complex_reasoning"]

[channels.discord]
allowed_channels = ["dm"]
allowed_users = []

[channels.claude_code]
permission_mode = "bypassPermissions"
working_dir = "/home/user/projects"
max_turns = 50

[channels.xmpp]
service = "xmpp://chat.example.com:5222"
domain = "example.com"
allowed_jids = ["alice@example.com"]

[channels.api]
port = 3000
host = "127.0.0.1"

[safety]
enabled = true

[safety.command_filter]
enabled = true

[safety.sensitive_files]
enabled = true

[safety.audit_log]
enabled = true
path = "{workspace}/audit.log"

[safety.path_sandbox]
enabled = false

[safety.confirmation]
enabled = false

[github]
# default_owner and default_repo are auto-detected from git remote

[tasks]
enabled = true
tick_interval_ms = 30000
max_active_tasks = 20
task_timeout_ms = 300000
discovery_enabled = true

[tasks.heartbeat]
enabled = true
schedule = "*/30 * * * *"

[transcript]
enabled = true

[skills]
dirs = ["~/.egirl/skills", "{workspace}/skills"]
```

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DISCORD_TOKEN=...
GITHUB_TOKEN=ghp_...
XMPP_USERNAME=egirl
XMPP_PASSWORD=...
```

## RuntimeConfig

The TOML config is loaded and transformed into a `RuntimeConfig` object at startup. Key transformations:

- Tilde (`~`) in paths is expanded to the home directory
- `{workspace}` placeholders are resolved
- TOML snake_case keys are converted to camelCase (`context_length` → `contextLength`)
- API keys from `.env` are merged into the `remote` section
- Default values from `src/config/defaults.ts` fill any gaps

The `RuntimeConfig` interface is defined in `src/config/schema.ts` and is the single source of truth for typed configuration throughout the application.
