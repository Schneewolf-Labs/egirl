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
- **[Memory system](docs/memory.md)** - Hybrid search (keyword + semantic) with multimodal embeddings
- **Multiple channels** - [Discord](DISCORD.md) DMs, terminal CLI, [XMPP/Jabber](docs/communication-protocols.md), [HTTP API](docs/configuration.md#channelsapi), and [Claude Code bridge](docs/claude-code.md)
- **[Tool use](docs/tools.md)** - File ops, git, command execution, memory search, web research, screenshots, and code agent delegation
- **[Vision](docs/vision.md)** - Screenshot analysis and image understanding via Qwen3-VL
- **[Skills](docs/skills.md)** - Extend capabilities with reusable Markdown instruction sets
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
│   ├── agent/                 # Core loop, context building
│   ├── providers/             # llama.cpp, Anthropic, OpenAI
│   ├── routing/               # Local vs remote decisions
│   ├── memory/                # SQLite + embeddings search
│   ├── tools/                 # File ops, exec, memory
│   ├── channels/              # CLI, Discord, Claude Code, XMPP, API
│   ├── skills/                # Skill loading and management
│   └── tracking/              # Usage stats and cost tracking
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

See [docs/tools.md](docs/tools.md) for the full reference with parameters and examples. egirl ships with 18 built-in tools. Tools use the [Qwen3 native tool calling format](docs/tool-format.md).

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents (with optional line ranges) |
| `write_file` | Write to file |
| `edit_file` | String replacement edit |
| `execute_command` | Run shell commands |
| `glob_files` | Find files by pattern |
| `memory_search` | Hybrid search memories |
| `memory_get` | Get memory by key |
| `memory_set` | Store a memory |
| `memory_delete` | Delete a memory |
| `memory_list` | List all stored memories |
| `screenshot` | Capture display screenshot |
| `web_research` | Fetch and read web pages |
| `git_status` | Show repo state |
| `git_diff` | Show changes |
| `git_log` | Show commit history |
| `git_commit` | Stage and commit |
| `git_show` | Show commit contents |
| `code_agent` | Delegate tasks to Claude Code |

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System overview, request lifecycle, module dependencies, design decisions |
| [Configuration](docs/configuration.md) | Complete reference for `egirl.toml` and `.env` |
| [Routing & Escalation](docs/routing.md) | How requests are routed between local and remote models |
| [Memory System](docs/memory.md) | Hybrid search, embeddings, storage, and search strategies |
| [Tools Reference](docs/tools.md) | All 18 built-in tools with parameters and examples |
| [Claude Code Integration](docs/claude-code.md) | Using egirl as a Claude Code supervisor |
| [Skills](docs/skills.md) | Creating and managing skill files |
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
- GPU with enough VRAM for your model

## License

MIT

---

<p align="center">
  Built by <a href="https://github.com/Schneewolf-Labs">Schneewolf Labs</a>
</p>
