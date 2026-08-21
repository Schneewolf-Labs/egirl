<p align="center">
  <img src="logo.png" alt="egirl" width="300" />
</p>

<p align="center">
  <strong>Local AI that runs its own loop.</strong><br>
  Point it at a goal, walk away, come back to finished work — or one sharp question. Meet Kira.
</p>

---

## What This Is

egirl is a long-running local AI agent built on one premise: **the agent is the human in the loop.**

In an ordinary agent harness a person supplies the judgment the model lacks — when to stop, when to keep going, when the work has drifted, when to write things down, when to ask for help. Run the agent unattended and every one of those becomes a gap that has to be real code. egirl is that code. Point a single instance at a goal, leave it alone for days, and it either finishes the job or comes back with a specific question — on your hardware, where compute is not the constraint. It runs indefinitely by default and stops only for reasons that genuinely warrant stopping.

It's a capable local operator that does the work itself: remembers your projects, drives a full toolbelt, and manages its own loop. When code should be handed off, `code_agent` (Claude Code or Codex) is there — one tool among many, not the point.

**Default personality: Kira** — confident, sharp, gets stuff done. Will tease you when you push to main.

See [docs/autonomy-loop.md](docs/autonomy-loop.md) for the full control model: what stops a run, how it survives its own context window, and how it involves a supervisor.

## The Mental Model

Everything flows through one idea:

> The local LLM is the operator. It does the work and runs its own loop. It escalates to **tools**, not to other models — and a supervisor (human *or* peer agent) is just a tool it reaches at the edge of its own authority.

No multi-model routing. No per-message cloud escalation. The local model solves it itself or calls a tool. `code_agent` is one of those tools — but for a capable operator, the lever is a stronger operator, not a delegation hop, so reach for it only when handing off code actually helps.

## Features

- **Runs indefinitely** — no artificial turn cap; a run ends on a real stop, not a counter
- **Consolidation breaks** — periodically checkpoints everything learned to durable notes, triggered on turn-interval, context pressure, *and* wall-clock (as a time budget nears), so a run survives its own context window instead of losing an hour of work to an interruption
- **Self-terminating on real failure** — stuck-inference abort and reasoning/repetition spiral detection end a run mechanically instead of grinding
- **Reports to a supervisor** — the `report` tool asks (blocking) or notifies (one-way) a supervisor that can be a peer agent *or* a human on a chat channel; a human is just a slow peer. An unanswered `ask` parks the task in an "awaiting input" state until a reply resumes it
- **Interject anytime** — `POST /sessions/:id/interrupt` aborts a background run or injects a message delivered at the next turn boundary; tasks pause / resume / delete over HTTP
- **Local-first** — llama.cpp on your box, zero API cost for coordination
- **Long-running memory** — hybrid keyword + semantic search, SQLite-backed, with auto-extraction and temporal recall
- **Conversation persistence** — picks up where you left off across restarts
- **Background tasks** — cron-scheduled work with business-hours awareness and dependency ordering
- **Tools that feel like hands** — file ops, shell, git, GitHub, browser (Playwright), web research, screenshots
- **Code agent on tap** — the `code_agent` tool delegates engineering work to Claude Code or Codex using your local CLI/subscription auth, for when a handoff actually helps
- **Four ways to talk to it** — interactive CLI, Discord DMs, self-hosted XMPP, or a minimal HTTP API (for scripts, automations, LAN access)
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
llama-server -m your-model.gguf -c 32768 --port 8080

# Check setup
bun run start doctor

# Start embedding service (for memory) — CPU-only, Qwen3-VL-Embedding-2B
bun run embeddings           # or: scripts/serve-embeddings.sh

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
provider = "qwen3-vl"   # or "llamacpp" | "openai"
endpoint = "http://localhost:8082"
model = "qwen3-vl-embedding-2b"
dimensions = 2048
multimodal = true

[channels.code_agent]
provider = "codex"      # or "claude"; Codex runs through the interactive codex CLI
permission_mode = "default"

[tools]
code_agent = true       # one tool among many — delegate coding to the configured code agent

# Who this instance reports to at the edge of its own authority (optional).
# "peer:<name>" for an agent supervisor, "discord:<id>" / "xmpp:<jid>" for a human.
[report]
to = "peer:supervisor"
```

### .env

```bash
DISCORD_TOKEN=...     # for Discord bot
XMPP_USERNAME=...     # for XMPP bot
XMPP_PASSWORD=...
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
bun run src/index.ts api                  # HTTP API on localhost:3000 (configurable)
bun run src/index.ts serve                # Discord/XMPP + background task runner
bun run src/index.ts claude-code          # Direct Claude Code bridge (alias: cc)
bun run src/index.ts cc -m "fix the tests"
bun run src/index.ts status               # Show config + connection status
bun run src/index.ts help
```

## Architecture

```
egirl/
├── egirl.toml                # Config
├── scripts/serve-embeddings.sh  # Launcher for the embedding service
├── src/
│   ├── agent/                # The local LLM's loop — the autonomy engine, memory-aware
│   ├── api.ts                # Minimal HTTP API (Bun.serve)
│   ├── bootstrap.ts          # Process wiring / startup
│   ├── browser/              # Playwright browser automation
│   ├── channels/             # CLI, Discord, XMPP, Claude Code bridge
│   ├── commands/             # Command runners
│   ├── config/               # TOML loading + TypeBox validation
│   ├── conversation/         # Persisted conversation store (SQLite)
│   ├── energy/               # Energy budget — constrains autonomous actions
│   ├── instances/            # Named multi-instance scaffold + preflight
│   ├── mcp/                  # MCP client integration
│   ├── memory/               # Hybrid keyword + embeddings search
│   ├── peers/                # Agent-to-agent peer protocol + discovery
│   ├── permissions/          # Code-agent permission supervisor
│   ├── providers/            # llama.cpp provider (tokenizer, reasoning floors)
│   ├── report/               # report tool + reply broker (ask/notify a supervisor)
│   ├── safety/               # Command filter, path guard, audit log
│   ├── session/              # Session / conversation state controller
│   ├── skills/               # Skill loading
│   ├── standup/              # Morning workspace context
│   ├── tasks/                # Cron scheduler, heartbeat, discovery
│   ├── tools/                # Built-in tools (file, git, github, browser, code_agent, report)
│   ├── tracking/             # Stats and JSONL transcripts
│   ├── ui/                   # 256-color theme
│   ├── util/                 # Logger, args, async helpers
│   ├── web-ui.ts             # Minimal browser chat page
│   └── workspace/            # Workspace bootstrapping
├── embedding-server/         # Python Qwen3-VL-Embedding-2B service (CPU-only)
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
| **Files** | `read_file`, `write_file`, `edit_file`, `glob_files` |
| **Shell** | `execute_command`, `process_start`, `process_output`, `process_send_input`, `process_stop`, `process_list` |
| **Memory** | `memory_search`, `memory_get`, `memory_set`, `memory_delete`, `memory_list`, `memory_recall`, `session_search` |
| **Git** | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_show` |
| **GitHub** | `gh_pr_*`, `gh_issue_*`, `gh_ci_status`, `gh_branch_create`, `gh_release_list` |
| **Browser** | `browser_navigate`, `browser_click`, `browser_fill`, `browser_snapshot`, `browser_screenshot`, etc. |
| **Tasks** | `task_add`, `task_propose`, `task_list`, `task_run_now`, `task_history`, `task_pause`, `task_resume`, `task_cancel` |
| **Supervision** | `report` — ask/notify a supervisor (peer agent or human channel); `peer_message`, `peer_list` |
| **Delegation** | `code_agent` — drive the configured code agent (optional, one tool among many) |
| **Other** | `screenshot`, `web_research`, `web_search`, `skill_read` |

See [docs/tools.md](docs/tools.md) for details.

## HTTP API

A small REST-ish API for scripts, automations, LAN clients, and mobile apps. Bun.serve, localhost-only by default, optional bearer auth via `EGIRL_API_TOKEN`.

```
GET    /                          → { service, version }  (or the chat page for a browser)
GET    /info                      → what this process is running
GET    /prompt?session_id=        → the composed system prompt
POST   /chat                      { message, session_id?, images? } → agent response
GET    /sessions                  → every conversation, newest first
GET    /sessions/:id              → messages
POST   /sessions/:id/interrupt    { action: "abort" | "inject", message? }
DELETE /sessions/:id              → clear session
GET    /memory?q=...&limit=       → search results
POST   /memory                    { key, value, category? }
DELETE /memory/:key
GET    /tasks?status=...          → list
POST   /tasks                     { name, prompt, kind, interval_ms?, cron?, unbounded? }
POST   /tasks/:id/run             → trigger a task immediately
POST   /tasks/:id/pause           → pause a task
POST   /tasks/:id/resume          → resume a paused/failed task
DELETE /tasks/:id                 → delete a task (aborts a running instance first)
POST   /peer/message              { from, message } → agent-to-agent (egirl-peer protocol)
GET    /peer/identity             → { service, protocol, name }
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
| [Autonomy Loop](docs/autonomy-loop.md) | Indefinite operation — what stops a run, context survival, supervision |
| [Architecture](docs/architecture.md) | System overview and module dependencies |
| [Configuration](docs/configuration.md) | `egirl.toml` and `.env` reference |
| [Memory](docs/memory.md) | Hybrid search, embeddings, storage |
| [Tools](docs/tools.md) | All built-in tools with parameters |
| [Background Tasks](docs/background-tasks.md) | Cron-scheduled task system |
| [Code Agent Integration](docs/code-agent.md) | The optional code-agent delegation flow |
| [Claude Code Bridge](docs/claude-code.md) | Direct Claude Code bridge channel |
| [Permission Supervisor](docs/permissions.md) | Code-agent permission policy and local-model decisions |
| [Skills](docs/skills.md) | Creating reusable skill files |
| [Safety](docs/safety.md) | Guardrails and their limits |
| [Tool Format](docs/tool-format.md) | Qwen3 native tool calling |
| [Personality](docs/personality.md) | Customizing Kira |
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
