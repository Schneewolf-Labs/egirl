<p align="center">
  <img src="logo.png" alt="egirl" width="300" />
</p>

<p align="center">
  <strong>Local AI that drives code agents.</strong><br>
  The human-in-the-loop for your coding agent. Meet Kira.
</p>

---

## What This Is

egirl is a long-running local AI agent. It runs on your hardware, remembers what you've been working on, and **delegates real engineering work to a code agent**. The local LLM plans and supervises; Claude Code or Codex executes.

Think of it as a competent colleague who lives in your cluster, knows your projects, and drives your coding agent so you don't have to write every prompt by hand.

**Default personality: Kira** — confident, sharp, gets stuff done. Will tease you when you push to main.

## The Mental Model

Everything flows through one idea:

> The local LLM is the operator. It escalates to **tools**, not to other models. The most important tool is `code_agent` — a wrapper around Claude Code or Codex.

No multi-model routing. No per-message cloud escalation. The local model solves it itself or calls a tool.

## Features

- **Local-first** — llama.cpp on your box, zero API cost for coordination
- **Code agent integration** — first-class `code_agent` tool that delegates engineering work to Claude Code or Codex using your local CLI/subscription auth
- **Long-running memory** — hybrid keyword + semantic search, SQLite-backed, with auto-extraction and temporal recall
- **Conversation persistence** — picks up where you left off across restarts
- **Background tasks** — cron-scheduled work with business-hours awareness and dependency ordering
- **Tools that feel like hands** — file ops, shell, git, GitHub, browser (Playwright), web research, screenshots
- **Six ways to talk to it** — interactive CLI, Discord DMs, self-hosted XMPP, Telegram, Matrix, or a minimal HTTP API (for scripts, automations, LAN access)
- **Skills** — reusable Markdown instruction sets
- **Safety guardrails** — command filter, path sandbox, sensitive file guard, audit log (guardrails, not a sandbox)
- **Customizable personality** — Kira's the default, replace her with whoever

## Quick Start

```bash
# Install dependencies
bun install

# Create starter config, then check it
bun run start init --provider codex

# Start llama.cpp (your local model)
# --jinja applies the model's chat template — required for tool calling and for
# reasoning models to stream their thinking out-of-band; -fa on enables flash attention.
llama-server -m your-model.gguf -c 32768 -fa on --jinja --port 8080

# Check setup
bun run start doctor

# Start embedding service (for memory)
cd services/embeddings && ./run.sh

# Run the CLI
bun run cli
```

## Configuration

Run `bun run start init --provider codex` to create a starter `egirl.toml` and `.env`. Use `--provider claude` if you want Claude Code as the `code_agent` backend. See [docs/configuration.md](docs/configuration.md) for the full reference.

### egirl.toml

```toml
[workspace]
path = "~/.egirl/workspace"

[local]
endpoint = "http://localhost:8080"
model = "qwen3-vl-32b"
context_length = 32768

[local.embeddings]
endpoint = "http://localhost:8082"
model = "qwen3-vl-embedding-2b"
dimensions = 2048
multimodal = true

[channels.code_agent]
provider = "codex"      # or "claude"; Codex runs through the interactive codex CLI
permission_mode = "default"

[tools]
code_agent = true     # the primary tool — delegate coding to the configured code agent
```

### .env

```bash
DISCORD_TOKEN=...     # for Discord bot
XMPP_USERNAME=...     # for XMPP bot
XMPP_PASSWORD=...
TELEGRAM_BOT_TOKEN=... # for Telegram bot (from @BotFather)
MATRIX_ACCESS_TOKEN=... # for Matrix bot (or MATRIX_USERNAME + MATRIX_PASSWORD)
EGIRL_API_TOKEN=...   # optional bearer token for the HTTP API (required if exposing on LAN)
GITHUB_TOKEN=...      # for gh_* tools
```

No `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` needed for egirl itself. Claude Code and Codex use their own local CLI subscription auth.

## Commands

```bash
bun run cli                               # Interactive CLI
bun run src/index.ts init --provider codex # Create starter config
bun run src/index.ts doctor               # Check local setup
bun run src/index.ts --instance ops-big cli # Run a named instance
bun run src/index.ts cli -m "hello"       # Single message, then exit
bun run src/index.ts discord              # Discord bot only
bun run src/index.ts xmpp                 # XMPP bot only (self-hosted)
bun run src/index.ts telegram             # Telegram bot only
bun run src/index.ts matrix               # Matrix bot only (unencrypted rooms)
bun run src/index.ts api                  # HTTP API on localhost:3000 (configurable)
bun run src/index.ts serve                # Discord/XMPP/Telegram/Matrix + background task runner
bun run src/index.ts claude-code          # Direct Claude Code bridge (alias: cc)
bun run src/index.ts cc -m "fix the tests"
bun run src/index.ts status               # Show config + connection status
bun run src/index.ts update               # Pull latest + bun install (alias: upgrade; --check to preview)
bun run src/index.ts help
```

## Architecture

```
egirl/
├── egirl.toml                # Config
├── src/
│   ├── agent/                # The local LLM's loop, memory-aware
│   ├── api.ts                # Minimal HTTP API (Bun.serve, ~200 lines)
│   ├── browser/              # Playwright browser automation
│   ├── channels/             # CLI, Discord, XMPP, Telegram, Matrix, Claude Code bridge
│   ├── commands/             # Command runners
│   ├── config/               # TOML loading + TypeBox validation
│   ├── conversation/         # Persisted conversation store (SQLite)
│   ├── memory/               # Hybrid keyword + embeddings search
│   ├── providers/            # llama.cpp (the only provider)
│   ├── safety/               # Command filter, path guard, audit log
│   ├── skills/               # Skill loading
│   ├── standup/              # Morning workspace context
│   ├── tasks/                # Cron scheduler, heartbeat, discovery
│   ├── tools/                # Built-in tools (file, git, github, browser, code_agent)
│   ├── tracking/             # Stats and JSONL transcripts
│   ├── ui/                   # 256-color theme
│   ├── util/                 # Logger, args, async helpers
│   └── workspace/            # Workspace bootstrapping
├── services/embeddings/      # Python Qwen3-VL-Embedding service
└── workspace/                # Personality templates (copied on first run)
```

## Customizing Kira

Personality files live in `~/.egirl/workspace/`:

- `IDENTITY.md` — Name, appearance, role
- `SOUL.md` — Personality, voice, behavior
- `USER.md` — Info about you
- `AGENTS.md` — Operating instructions

Edit to customize, or replace Kira entirely. See [docs/personality.md](docs/personality.md).

## Tools

egirl ships with tools across six categories. Format: Qwen3 native tool calling ([docs/tool-format.md](docs/tool-format.md)).

| Category | Tools |
|----------|-------|
| **Delegation (primary)** | `code_agent` — drive the configured code agent |
| **Files** | `read_file`, `write_file`, `edit_file`, `glob_files` |
| **Shell** | `execute_command` |
| **Memory** | `memory_search`, `memory_get`, `memory_set`, `memory_delete`, `memory_list`, `memory_recall` |
| **Git** | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_show` |
| **GitHub** | `gh_pr_*`, `gh_issue_*`, `gh_ci_status`, `gh_branch_create` |
| **Browser** | `browser_navigate`, `browser_click`, `browser_fill`, `browser_snapshot`, `browser_screenshot`, etc. |
| **Tasks** | `task_add`, `task_propose`, `task_list`, `task_run_now`, `task_history`, etc. |
| **Other** | `screenshot`, `web_research`, `web_search` |

See [docs/tools.md](docs/tools.md) for details.

## HTTP API

A small REST-ish API for scripts, automations, LAN clients, and mobile apps. Bun.serve, localhost-only by default, optional bearer auth via `EGIRL_API_TOKEN`.

```
GET    /                     → { service, version }
POST   /chat                 { message, session_id? } → agent response
GET    /sessions/:id         → messages
DELETE /sessions/:id         → clear session
GET    /memory?q=...&limit=  → search results
POST   /memory               { key, value, category? }
DELETE /memory/:key
GET    /tasks?status=...     → list
POST   /tasks                { name, prompt, kind, interval_ms?, cron? }
POST   /tasks/:id/run        → trigger a task immediately
```

Example:
```bash
curl -s http://localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"message":"what did we work on yesterday?"}' | jq -r .content
```

No OpenAPI spec, no versioned paths, no plugin framework. If you want to build something on top, talk to egirl over HTTP in whatever language you like.

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System overview and module dependencies |
| [Configuration](docs/configuration.md) | `egirl.toml` and `.env` reference |
| [Memory](docs/memory.md) | Hybrid search, embeddings, storage |
| [Tools](docs/tools.md) | All built-in tools with parameters |
| [Background Tasks](docs/background-tasks.md) | Cron-scheduled task system |
| [Code Agent Integration](docs/code-agent.md) | The core delegation flow |
| [Claude Code Bridge](docs/claude-code.md) | Direct Claude Code bridge channel |
| [Permission Supervisor](docs/permissions.md) | Code-agent permission policy and local-model decisions |
| [Skills](docs/skills.md) | Creating reusable skill files |
| [Safety](docs/safety.md) | Guardrails and their limits |
| [Tool Format](docs/tool-format.md) | Qwen3 native tool calling |
| [Personality](docs/personality.md) | Customizing Kira |
| [Deployment](docs/deployment.md) | Serving stack, context sizing, duplicating an instance to another box |
| [Development](docs/development.md) | Setup, testing, style |

## Requirements

- [Bun](https://bun.sh)
- [llama.cpp](https://github.com/ggerganov/llama.cpp) server
- Python 3.10+ (optional — embeddings service)
- Playwright browsers (optional — `bunx playwright install`)
- GPU with enough VRAM for your model

## License

MIT

---

<p align="center">
  Built by <a href="https://github.com/Schneewolf-Labs">Schneewolf Labs</a>
</p>
