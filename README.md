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
- **Smart routing** - Escalates to Claude/GPT only when needed
- **Memory system** - Hybrid search (keyword + semantic) with multimodal embeddings
- **Discord & CLI** - Talk via Discord DMs or terminal
- **Tool use** - File ops, command execution, memory search
- **Customizable personality** - Kira is the default, make her your own

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

# Or Discord bot
bun run start discord
```

## Configuration

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
bun run start status           # Check config and connections
bun run start help             # Show all commands
```

## Architecture

```
egirl/
├── egirl.toml                 # Config
├── src/
│   ├── agent/                 # Core loop, context building
│   ├── providers/             # llama.cpp, Anthropic, OpenAI
│   ├── routing/               # Local vs remote decisions
│   ├── memory/                # SQLite + embeddings search
│   ├── tools/                 # File ops, exec, memory
│   └── channels/              # CLI, Discord
├── services/
│   └── embeddings/            # Qwen3-VL-Embedding Python service
└── templates/                 # Default personality (Kira)
```

## Customizing Kira

Personality files live in `~/.egirl/workspace/`:

- `IDENTITY.md` - Name, appearance, role
- `SOUL.md` - Personality, voice, behavior
- `USER.md` - Info about you
- `AGENTS.md` - Operating instructions

Edit these to customize. Or replace Kira entirely.

## Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Write to file |
| `edit_file` | String replacement edit |
| `execute_command` | Run shell commands |
| `glob_files` | Find files by pattern |
| `memory_search` | Hybrid search memories |
| `memory_get` | Get memory by key |
| `memory_set` | Store a memory |

## Requirements

- [Bun](https://bun.sh) runtime
- [llama.cpp](https://github.com/ggerganov/llama.cpp) server
- Python 3.10+ (for embedding service)
- GPU with enough VRAM for your model

## License

MIT

---

<p align="center">
  Built by <a href="https://github.com/Schneewolf-Labs">Schneewolf Labs</a>
</p>
