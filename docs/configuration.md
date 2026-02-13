# Configuration Reference

egirl is configured through two files: `egirl.toml` for application settings and `.env` for secrets.

## egirl.toml

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

If neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` is set, all requests route to the local model regardless of routing rules. The agent will log a warning but function normally.

## Remote Provider Priority

When both API keys are set:
1. **Anthropic** is used as the primary remote provider
2. **OpenAI** is the fallback if Anthropic is not configured

This priority is hardcoded in `src/providers/index.ts`.

## Full Example

```toml
# egirl.toml

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

[skills]
dirs = ["~/.egirl/skills", "{workspace}/skills"]
```

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DISCORD_TOKEN=...
```

## RuntimeConfig

The TOML config is loaded and transformed into a `RuntimeConfig` object at startup. Key transformations:

- Tilde (`~`) in paths is expanded to the home directory
- `{workspace}` placeholders are resolved
- TOML snake_case keys are converted to camelCase (`context_length` → `contextLength`)
- API keys from `.env` are merged into the `remote` section
- Default values from `src/config/defaults.ts` fill any gaps

The `RuntimeConfig` interface is defined in `src/config/schema.ts` and is the single source of truth for typed configuration throughout the application.
