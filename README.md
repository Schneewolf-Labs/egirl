<p align="center">
  <img src="logo.png" alt="egirl" width="300" />
</p>

<p align="center">
  <strong>Local-first AI agent that runs on your hardware</strong><br>
  Escalates to cloud only when needed. Meet Kira.
</p>

---

## What This Is

egirl is a personal AI agent for users with local GPU inference. It runs most tasks locally via llama.cpp, remembers conversations, and intelligently escalates to Claude or GPT when complexity demands it.

**Default personality: Kira** - confident, sharp, gets stuff done. Will tease you when you push to main.

## Features

- **Local-first** - Runs on your hardware, zero API cost for most tasks
- **[Smart routing](docs/routing.md)** - Escalates to Claude/GPT only when needed, with configurable thresholds and mid-conversation escalation
- **[Memory system](docs/memory.md)** - Hybrid search (keyword + semantic) with multimodal embeddings, auto-extraction, and temporal queries
- **Multiple channels** - [Discord](DISCORD.md) DMs, terminal CLI, [XMPP/Jabber](docs/communication-protocols.md), [HTTP API](docs/configuration.md#channelsapi), and [Claude Code bridge](docs/claude-code.md)
- **[Tool use](docs/tools.md)** - File ops, git, GitHub API, command execution, memory, web research, browser automation, screenshots, background tasks, and code agent delegation
- **[Background tasks](docs/background-tasks.md)** - Scheduled, event-driven, and one-shot tasks with workflow engine, discovery, and outbound notifications
- **[Vision](docs/vision.md)** - Screenshot analysis and image understanding via Qwen3-VL
- **[Browser automation](docs/tools.md#browser-tools)** - Full Playwright-based browser control with accessibility targeting
- **[Skills](docs/skills.md)** - Extend capabilities with reusable Markdown instruction sets
- **[Safety](docs/safety.md)** - Command blocklist, path sandboxing, sensitive file guard, audit logging
- **[Customizable personality](docs/personality.md)** - Kira is the default, make her your own

## Quick Start

```bash
# Install dependencies
bun install

# Configure
cp .env.example .env
# Edit .env with your API keys (optional - only needed for escalation)

# Start llama.cpp server (your local model)
llama-server -m your-model.gguf -c 32768 --port 8080

# Start embedding service (for memory)
cd services/embeddings && ./run.sh

# Run CLI
bun run start cli

# Or Discord bot (see DISCORD.md for setup)
bun run start discord
```

## Configuration

See [docs/configuration.md](docs/configuration.md) for the full reference including all channel options, routing rules, and skill directories.

### egirl.toml

```toml
[workspace]
path = "~/.egirl/workspace"

[local]
endpoint = "http://localhost:8080"      # llama.cpp server
model = "qwen3-vl-32b"
context_length = 32768

[local.embeddings]
endpoint = "http://localhost:8082"      # Qwen3-VL-Embedding service
model = "qwen3-vl-embedding-2b"
dimensions = 2048
multimodal = true

[routing]
default = "local"
escalation_threshold = 0.4
always_local = ["memory_search", "memory_get", "greeting"]
always_remote = ["code_generation", "complex_reasoning"]

[channels.discord]
allowed_channels = ["dm"]
allowed_users = []  # empty = allow all
```

### .env

```bash
ANTHROPIC_API_KEY=sk-ant-...   # Optional - for escalation
OPENAI_API_KEY=sk-...          # Optional - for escalation
DISCORD_TOKEN=...              # Required for Discord bot
```

## Commands

```bash
bun run start cli              # Interactive CLI
bun run start cli -m "hello"   # Single message
bun run start discord          # Discord bot
bun run start claude-code      # Claude Code bridge (or: cc)
bun run start xmpp             # XMPP/Jabber chat
bun run start api              # HTTP REST API server
bun run start status           # Check config and connections
bun run start help             # Show all commands
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full system overview, request lifecycle, module dependencies, and design decisions.

```
egirl/
├── egirl.toml                 # Config
├── src/
│   ├── agent/                 # Core loop, context building, summarization
│   ├── api/                   # HTTP REST server (chat, tools, memory, stats)
│   ├── browser/               # Playwright browser automation
│   ├── channels/              # CLI, Discord, Claude Code, XMPP, API
│   ├── commands/              # Command runners (cli, discord, xmpp, api, etc.)
│   ├── config/                # TOML loading, validation, defaults
│   ├── conversation/          # Conversation persistence (SQLite)
│   ├── memory/                # SQLite + embeddings search
│   ├── providers/             # llama.cpp, Anthropic, OpenAI
│   ├── routing/               # Local vs remote decisions
│   ├── safety/                # Command filter, path sandbox, audit log
│   ├── skills/                # Skill loading and management
│   ├── standup/               # Daily workspace context gathering
│   ├── tasks/                 # Background task scheduler, events, workflows
│   ├── tools/                 # 48 built-in tools (file, git, GitHub, browser, etc.)
│   ├── tracking/              # Usage stats, cost tracking, transcripts
│   ├── ui/                    # Theme system (256-color ANSI)
│   ├── util/                  # Logger, token counting, async helpers
│   └── workflows/             # Workflow engine for structured multi-step tasks
├── services/
│   └── embeddings/            # Qwen3-VL-Embedding service
└── workspace/                 # Default personality templates (Kira)
```

## Customizing Kira

See [docs/personality.md](docs/personality.md) for the full guide on creating custom personalities with examples.

Personality files live in `~/.egirl/workspace/`:

- `IDENTITY.md` - Name, appearance, role
- `SOUL.md` - Personality, voice, behavior
- `USER.md` - Info about you
- `AGENTS.md` - Operating instructions

Edit these to customize. Or replace Kira entirely.

## Tools

See [docs/tools.md](docs/tools.md) for the full reference with parameters and examples. egirl ships with 48 built-in tools across 8 categories. Tools use the [Qwen3 native tool calling format](docs/tool-format.md).

| Category | Tools | Description |
|----------|-------|-------------|
| **File ops** | `read_file`, `write_file`, `edit_file`, `glob_files` | Read, write, edit, and find files |
| **Commands** | `execute_command` | Run shell commands with timeout |
| **Memory** | `memory_search`, `memory_get`, `memory_set`, `memory_delete`, `memory_list` | Hybrid search, store, and manage memories |
| **Git** | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_show` | Repository operations |
| **GitHub** | `gh_pr_list`, `gh_pr_view`, `gh_pr_create`, `gh_pr_review`, `gh_pr_comment`, `gh_issue_list`, `gh_issue_view`, `gh_issue_comment`, `gh_issue_update`, `gh_ci_status`, `gh_branch_create` | Pull requests, issues, CI, and branches |
| **Browser** | `browser_navigate`, `browser_click`, `browser_fill`, `browser_snapshot`, `browser_screenshot`, `browser_select`, `browser_check`, `browser_hover`, `browser_wait`, `browser_eval`, `browser_close` | Playwright-based browser automation |
| **Tasks** | `task_add`, `task_propose`, `task_list`, `task_pause`, `task_resume`, `task_cancel`, `task_run_now`, `task_history` | Background task management |
| **Other** | `screenshot`, `web_research`, `code_agent` | Screen capture, web fetching, Claude Code delegation |

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System overview, request lifecycle, module dependencies, design decisions |
| [Configuration](docs/configuration.md) | Complete reference for `egirl.toml` and `.env` |
| [Routing & Escalation](docs/routing.md) | How requests are routed between local and remote models |
| [Memory System](docs/memory.md) | Hybrid search, embeddings, storage, and search strategies |
| [Tools Reference](docs/tools.md) | All 48 built-in tools with parameters and examples |
| [Background Tasks](docs/background-tasks.md) | Scheduled, event-driven, and one-shot background task framework |
| [Claude Code Integration](docs/claude-code.md) | Using egirl as a Claude Code supervisor |
| [Skills](docs/skills.md) | Creating and managing skill files |
| [Safety](docs/safety.md) | Command filtering, path sandboxing, sensitive file guard, audit logging, confirmation mode |
| [Security Analysis](docs/security-analysis.md) | Threat model and security considerations |
| [Development Guide](docs/development.md) | Setup, testing, code style, and contributing |
| [Discord Setup](DISCORD.md) | Step-by-step Discord bot configuration |
| [Tool Format](docs/tool-format.md) | Qwen3 native tool calling specification |
| [Vision](docs/vision.md) | Multimodal capabilities with Qwen3-VL |
| [Personality](docs/personality.md) | Customizing agent personality via workspace files |
| [Communication Protocols](docs/communication-protocols.md) | Evaluation of self-hosted chat protocols (XMPP, Matrix, SimpleX, IRC) |
| [Conversation Persistence](docs/exploration-conversation-persistence.md) | Design exploration for persisting conversations across restarts |
| [Fine-Tuning](docs/fine-tuning.md) | Training data strategy for custom models |

## Requirements

- [Bun](https://bun.sh) runtime
- [llama.cpp](https://github.com/ggerganov/llama.cpp) server
- Python 3.10+ (optional — for embedding service)
- Playwright browsers (optional — for browser automation tools, install with `bunx playwright install`)
- GPU with enough VRAM for your model

## License

MIT

---

<p align="center">
  Built by <a href="https://github.com/Schneewolf-Labs">Schneewolf Labs</a>
</p>
