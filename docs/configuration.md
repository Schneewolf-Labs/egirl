# Configuration Reference

egirl is configured through two files: `egirl.toml` for application settings and `.env` for secrets.

## egirl.toml

### Top-level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `theme` | string | `"egirl"` | CLI color theme. Options: `"egirl"` (purple/pink), `"midnight"` (blue/teal), `"neon"` (green/cyan), `"mono"` (grayscale) |

### `[thinking]`

Controls Qwen3 `/think` mode (extended reasoning).

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

Settings for the local llama.cpp server. This is the only LLM provider.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `endpoint` | string | `http://localhost:8080` | URL of the llama.cpp HTTP server |
| `model` | string | `qwen2.5-32b-instruct` | Model name (for display/logging — the server decides which model to load) |
| `context_length` | number | `32768` | Maximum context window in tokens. Should match your llama.cpp server's `-c` flag |
| `max_concurrent` | number | `2` | Maximum concurrent requests to the local server |
| `stale_stream_timeout_ms` | number | `90000` | Kill a streaming request that has produced no new tokens for this long |

### `[local.embeddings]`

Optional. If omitted, the memory system is disabled entirely.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | `"qwen3-vl"` \| `"llamacpp"` \| `"openai"` | `"qwen3-vl"` | Which embedding backend to use |
| `endpoint` | string | `http://localhost:8082` | URL of the embedding server |
| `model` | string | `qwen3-vl-embedding-2b` | Embedding model name (for logging) |
| `dimensions` | number | `2048` | Embedding vector dimensions. Must match the model's output |
| `multimodal` | boolean | `true` | Whether the embedding model accepts image inputs (Qwen3-VL-Embedding does) |
| `api_key` | string | — | API key (only used by the `openai` provider) |
| `base_url` | string | — | Custom base URL (only used by the `openai` provider) |

### `[channels.discord]`

Required only when running `discord` (or `serve`). The Discord token itself goes in `.env`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `allowed_channels` | string[] | `["dm"]` | Channel IDs where the bot responds. `"dm"` for direct messages, or numeric channel IDs |
| `allowed_users` | string[] | `[]` | User IDs allowed to interact. Empty = allow all |
| `passive_channels` | string[] | `[]` | Channels where the bot lurks — reads but only responds when a batch evaluator decides it's relevant |
| `batch_window_ms` | number | `3000` | Debounce window for grouping consecutive messages before responding |

### `[channels.claude_code]`

Settings for the Claude Code bridge channel (`claude-code` / `cc` command). This is distinct from the `code_agent` tool.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `permission_mode` | string | `"bypassPermissions"` | How Claude Code handles tool permissions. See values below |
| `model` | string | (none) | Override the Claude model (e.g. `"sonnet"`, `"opus"`, `"haiku"`) |
| `working_dir` | string | workspace path | Working directory for Claude Code operations |
| `max_turns` | number | (none) | Maximum agentic turns before stopping |

**Permission modes:**
- `"default"` — Claude Code asks permission on each tool use; local model answers
- `"acceptEdits"` — Auto-approve file edits, ask about everything else
- `"bypassPermissions"` — Skip all permission prompts (trust Claude Code)
- `"plan"` — Claude Code creates a plan before executing

### `[channels.code_agent]`

Settings for the `code_agent` tool. If omitted, egirl falls back to `[channels.claude_code]` for backward compatibility.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | string | `"claude"` | Code agent backend: `"claude"`, `"codex"`, or `"opencode"` |
| `permission_mode` | string | `"bypassPermissions"` | Agent permission mode. For Codex, non-bypass modes use the interactive CLI with a workspace-write sandbox and local-model prompt decisions. For opencode, `bypassPermissions`/`acceptEdits` pass `--dangerously-skip-permissions`, `plan` runs the opencode `plan` agent, and `default` keeps opencode's own permission config |
| `model` | string | (none) | Override the selected backend model. opencode expects `provider/model`, e.g. `anthropic/claude-sonnet-4-5` |
| `working_dir` | string | workspace path | Working directory for code agent operations |
| `max_turns` | number | (none) | Maximum Claude Code turns before stopping. Ignored by Codex and opencode |

**Migration note:** existing Claude-only configs can keep `[channels.claude_code]` unchanged. To configure the tool explicitly, add `[channels.code_agent] provider = "claude"` and copy any shared `permission_mode`, `model`, or `working_dir` values. To use Codex instead, set `provider = "codex"`; `[channels.claude_code]` still only controls the direct `claude-code` / `cc` bridge command. To use opencode, install the [`opencode`](https://opencode.ai) CLI, authenticate it (`opencode auth login`), and set `provider = "opencode"`; egirl runs it headless via `opencode run`. Set `OPENCODE_BIN` to point at a non-PATH binary.

### Multi-Instance Config

Optional `[profiles]`, `[personas]`, and `[instances]` sections let one TOML file define many egirl deployments.

- **Profiles** hold runtime/backend settings such as local model endpoints and code-agent backend.
- **Personas** hold identity/workspace settings such as theme and workspace path.
- **Instances** marry one profile to one persona and can override any nested config.

Profiles, personas, and instances use the **same nested keys as the top-level config** — there is no separate flat syntax. Unknown keys are rejected at load time, so typos surface immediately. If a persona omits `workspace`, it defaults to `<workspace_root>/personas/<name>`.

Run a named instance with `--instance`:

```bash
bun run start --instance kira-local cli
bun run start --instance ops-big doctor
```

Example:

```toml
[defaults]
workspace_root = "~/.egirl"
profile = "local-codex"
persona = "kira"

[profiles.local-codex.local]
endpoint = "http://localhost:8080"
model = "qwen3-vl-32b"

[profiles.local-codex.channels.code_agent]
provider = "codex"
permission_mode = "default"

[profiles.big-box.local]
endpoint = "http://192.168.8.218:8080"
model = "qwen3-72b"

[profiles.big-box.channels.code_agent]
provider = "codex"
permission_mode = "default"

[personas.kira]
theme = "egirl"
# workspace defaults to ~/.egirl/personas/kira

[personas.ops]
theme = "midnight"

[instances.kira-local]
profile = "local-codex"
persona = "kira"

[instances.ops-big]
profile = "big-box"
persona = "ops"

[instances.ops-big.channels.api]
port = 3001
```

The existing top-level config remains valid and acts as the base. Resolution order is top-level config, selected profile, selected persona, then selected instance.

### `[channels.xmpp]`

Required only when running `xmpp` (or `serve` with XMPP configured). XMPP credentials (`XMPP_USERNAME`, `XMPP_PASSWORD`) go in `.env`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `service` | string | `xmpp://localhost:5222` | XMPP server URI. Use `xmpps://` for direct TLS |
| `domain` | string | (derived from service) | XMPP domain (e.g. `example.com`) |
| `resource` | string | `egirl` | XMPP resource identifier |
| `allowed_jids` | string[] | `[]` | Bare JIDs allowed to message. Empty = allow all |

### `[channels.api]`

Required only when running `api` (or `serve` with the API enabled).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `host` | string | `127.0.0.1` | Bind address. Use `0.0.0.0` to listen on all interfaces (requires `EGIRL_API_TOKEN`) |
| `port` | number | `3000` | Port for the HTTP API server |

See the [README](../README.md#http-api) for the endpoint list.

### `[conversation]`

Optional. Controls conversation persistence and compaction.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Persist conversations to SQLite |
| `max_age_days` | number | `30` | Drop messages older than this during startup compaction |
| `max_messages` | number | `1000` | Cap messages per session |
| `compact_on_startup` | bool | `true` | Run compaction when egirl starts |
| `context_compaction` | bool | `true` | Summarize interior messages when context fills instead of dropping |

### `[memory]`

Optional. Tunes the memory system. The memory system itself is enabled by `[local.embeddings]`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `proactive_retrieval` | bool | `true` | Inject relevant memories into context before each turn |
| `score_threshold` | number | `0.35` | Minimum relevance score to include a memory |
| `max_results` | number | `5` | Maximum memories injected per turn |
| `max_tokens_budget` | number | `2000` | Token budget for injected memories |
| `auto_extract` | bool | `true` | After each turn, scan for notable facts and store them |
| `extraction_min_messages` | number | `2` | Minimum messages before auto-extraction runs |
| `extraction_max_per_turn` | number | `5` | Maximum memories extracted per turn |

### `[safety]`

Master switch and per-feature toggles for the safety layer. See [safety.md](safety.md) for the full guide.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Master switch for all safety features |

#### `[safety.command_filter]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Block dangerous shell commands |
| `mode` | `"block"` \| `"allow"` | `"block"` | `block`: blocklist + built-in dangerous patterns. `allow`: allowlist — only permitted commands run |
| `blocked_patterns` | string[] | `[]` | Additional regex patterns appended to the built-in blocklist |
| `extra_allowed` | string[] | `[]` | In `allow` mode, commands permitted in addition to the built-in safe list |

#### `[safety.path_sandbox]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Restrict file operations to allowed directories |
| `allowed_paths` | string[] | `[]` | Directories file ops are restricted to. Supports `{workspace}` and `~` |

#### `[safety.sensitive_files]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Block access to sensitive files (`.env`, SSH keys, credentials) |
| `patterns` | string[] | `[]` | Additional regex patterns appended to the built-in list |

#### `[safety.audit_log]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Log every tool call (including blocked ones) to JSONL |
| `path` | string | — | Path to the audit log file. Supports `{workspace}` |

#### `[safety.confirmation]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `false` | Require CLI confirmation before running destructive tools |
| `tools` | string[] | `["execute_command", "write_file", "edit_file"]` | Tools that require confirmation |

#### `[safety.permission_rules]`

Pattern-based allow/deny rules that match on `tool_name(argument_pattern)`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `allow` | string[] | `[]` | Patterns to auto-allow (e.g. `"execute_command(bun test*)"`) |
| `deny` | string[] | `[]` | Patterns to always deny |

### `[github]`

Optional. Configures defaults for the GitHub tools. `GITHUB_TOKEN` must be set in `.env`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `default_owner` | string | (auto-detected from git remote) | Default repository owner |
| `default_repo` | string | (auto-detected from git remote) | Default repository name |

### `[searxng]`

Optional. Powers the `web_search` tool.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `url` | string | — | URL of a SearxNG instance |

`SEARXNG_API_KEY` may be set in `.env` if your instance requires it.

### `[energy]`

Optional. Per-user energy budget that throttles expensive tool calls.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Enable energy accounting |
| `max_energy` | number | `20` | Max energy pool |
| `regen_per_hour` | number | `10` | Regen rate per hour |

### `[tasks]`

Optional. Configures the [background task framework](background-tasks.md).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Enable background task system |
| `tick_interval_ms` | number | `30000` | How often to check for due scheduled tasks (ms) |
| `max_active_tasks` | number | `20` | Maximum active tasks at once |
| `max_concurrent_tasks` | number | `1` | Tasks running simultaneously |
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

Optional. JSONL conversation transcripts.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Log conversations to JSONL files |
| `path` | string | (workspace default) | Path to the transcript log file. Supports `{workspace}` |

### `[permission_supervisor]`

Controls how egirl answers code-agent permission, trust, and clarification prompts. The shared supervisor is currently used by the Codex `code_agent` backend. The direct Claude Code bridge has its own local-model supervisor; Claude through `code_agent` still follows Claude Agent SDK permission behavior.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mode` | `"bypass"` \| `"supervised"` \| `"rules_only"` \| `"ask_user"` | `"supervised"` | Decision mode. `supervised` applies rules then asks the local model; `rules_only` skips model decisions; `ask_user` always requires user approval |
| `default_action` | `"allow"` \| `"deny"` \| `"ask_user"` | `"allow"` | Fallback when no rule/model decision applies |
| `think_before_deciding` | bool | `true` | Tells the local model to reason about risk before returning strict JSON |
| `min_confidence` | number | `0.65` | Confidence threshold used when `ask_user_below_confidence` is enabled |
| `ask_user_below_confidence` | bool | `false` | Escalate low-confidence model decisions to user approval |
| `memory_recall` | bool | `true` | Recall relevant project/preference memories before model decisions |
| `memory_write` | bool | `false` | Store compact decision traces in memory |

#### `[permission_supervisor.policy]`

Policy lists are simple substring/wildcard patterns matched against backend, prompt text, tool name, working directory, recent context, and tool input.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `allow` | string[] | `[]` | Auto-allow matching requests |
| `deny` | string[] | `[]` | Auto-deny matching requests |
| `ask_user` | string[] | `[]` | Require user approval for matching requests |

Example:

```toml
[permission_supervisor]
mode = "supervised"
default_action = "allow"
think_before_deciding = true
ask_user_below_confidence = true
min_confidence = 0.75
memory_recall = true
memory_write = false

[permission_supervisor.policy]
allow = ["git status", "bun test"]
deny = ["rm -rf", ".env"]
ask_user = ["git push", "curl"]
```

When the supervisor returns `ask_user` inside a non-resumable `code_agent` run, the tool stops and reports that user approval is needed. A resumable pending-approval store is future work.

### `[tools]`

Enable / disable tool groups.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `files` | bool | `true` | `read_file`, `write_file`, `edit_file`, `glob_files` |
| `exec` | bool | `true` | `execute_command` |
| `git` | bool | `true` | `git_*` |
| `memory` | bool | `true` | `memory_*` |
| `browser` | bool | `false` | `browser_*` (requires `bunx playwright install`) |
| `github` | bool | `false` | `gh_*` (requires `GITHUB_TOKEN`) |
| `tasks` | bool | `false` | `task_*` |
| `code_agent` | bool | `false` | `code_agent` — **the primary tool; enable this**. Backend is configured in `[channels.code_agent]` |
| `web_research` | bool | `true` | `web_research` |
| `web_search` | bool | `true` | `web_search` (requires `[searxng]`) |
| `screenshot` | bool | `true` | `screenshot` |

### `[skills]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `dirs` | string[] | `["~/.egirl/skills", "{workspace}/skills"]` | Directories scanned for `SKILL.md` files. `{workspace}` is replaced with the workspace path |

## .env

Create starter files with `bun run start init --provider codex`, or copy the template manually with `cp .env.example .env`.

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | For Discord mode | Discord bot token |
| `XMPP_USERNAME` | For XMPP mode | XMPP account username (local part, without domain) |
| `XMPP_PASSWORD` | For XMPP mode | XMPP account password |
| `EGIRL_API_TOKEN` | For API mode on LAN | Bearer token required on HTTP API requests. Recommended whenever `host` is not `127.0.0.1` |
| `GITHUB_TOKEN` | For GitHub tools | GitHub personal access token (for PR, issue, CI tools) |
| `SEARXNG_API_KEY` | Optional | API key if your SearxNG instance requires one |

**No `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is needed for egirl itself.** Claude Code uses subscription auth via `claude auth login`; Codex uses your local `codex` CLI login; opencode uses its own `opencode auth login`.

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
provider = "qwen3-vl"
endpoint = "http://localhost:8082"
model = "qwen3-vl-embedding-2b"
dimensions = 2048
multimodal = true

[channels.code_agent]
provider = "codex"      # "claude" or "codex"
permission_mode = "default"
# model = "gpt-5.5"
# working_dir = "~/projects/myrepo"

# Direct Claude Code bridge command only: bun run start cc
# [channels.claude_code]
# permission_mode = "bypassPermissions"
# model = "sonnet"

# [channels.discord]
# allowed_channels = ["dm"]
# allowed_users = []

# [channels.xmpp]
# service = "xmpp://localhost:5222"
# allowed_jids = ["you@localhost"]

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

[safety.confirmation]
enabled = false

[tools]
code_agent = true   # the primary tool — delegate coding to the configured code agent

[skills]
dirs = ["~/.egirl/skills", "{workspace}/skills"]
```

```bash
# .env
DISCORD_TOKEN=...
XMPP_USERNAME=egirl
XMPP_PASSWORD=...
EGIRL_API_TOKEN=...
GITHUB_TOKEN=ghp_...
```

## RuntimeConfig

The TOML config is loaded and transformed into a `RuntimeConfig` object at startup. Key transformations:

- Tilde (`~`) in paths is expanded to the home directory
- `{workspace}` placeholders are resolved
- TOML snake_case keys are converted to camelCase (`context_length` → `contextLength`)
- Secrets from `.env` are merged into the relevant sections (e.g. `channels.discord.token`, `github.token`)
- Default values fill any gaps

The `RuntimeConfig` interface is defined in `src/config/schema.ts` and is the single source of truth for typed configuration throughout the application.
