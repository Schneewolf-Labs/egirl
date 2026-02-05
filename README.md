# egirl

A local-first AI agent that runs on your own hardware and escalates to cloud providers only when needed.

## What This Is

egirl is a personal AI agent designed for users with local GPU inference capability. It communicates via Discord and terminal, runs most tasks locally using llama.cpp, and intelligently escalates to Claude or GPT when the complexity demands it—keeping API costs low while maintaining quality where it matters.

## Quick Start

```bash
# Install dependencies
bun install

# Configure secrets
cp .env.example .env
# Edit .env with your API keys

# Run interactive CLI
bun run cli

# Or send a single message
bun run cli -- -m "Hello, how are you?"

# Check status
bun run start status
```

## Configuration

Config is in `egirl.toml`. Secrets (API keys) go in `.env`.

### egirl.toml

```toml
[workspace]
path = "~/.egirl/workspace"

[local]
endpoint = "http://localhost:8080"      # llama.cpp server
model = "qwen2.5-32b-instruct"
context_length = 32768
max_concurrent = 2

[local.embeddings]
endpoint = "http://localhost:8081"      # separate embedding server
model = "nomic-embed-text-v1.5"

[routing]
default = "local"
escalation_threshold = 0.4
always_local = ["memory_search", "memory_get", "greeting", "acknowledgment"]
always_remote = ["code_generation", "code_review", "complex_reasoning"]

[channels.discord]
allowed_channels = ["dm"]
allowed_users = ["YOUR_DISCORD_ID"]

[skills]
dirs = ["~/.egirl/skills", "{workspace}/skills"]
```

### .env (secrets only)

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DISCORD_TOKEN=...
```

## Architecture

```
egirl/
├── egirl.toml                # Main config file
├── .env                      # Secrets only
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # Load egirl.toml + .env
│   ├── agent/
│   │   ├── loop.ts           # Core loop: route → execute → respond
│   │   └── context.ts        # Build system prompt
│   ├── router/
│   │   ├── router.ts         # Decide local vs remote
│   │   ├── escalation.ts     # Detect when local needs escalation
│   │   └── heuristics.ts     # Fast pattern-match rules
│   ├── providers/
│   │   ├── types.ts          # LLMProvider interface
│   │   ├── llamacpp.ts       # llama.cpp HTTP client
│   │   ├── anthropic.ts      # Claude client
│   │   └── openai.ts         # OpenAI client
│   ├── tools/
│   │   ├── registry.ts       # Tool registration
│   │   ├── executor.ts       # Run tool calls
│   │   └── builtin/          # read, write, edit, exec, glob, memory
│   ├── memory/
│   │   ├── manager.ts        # MEMORY.md and daily logs
│   │   └── search.ts         # Hybrid BM25 + vector search
│   ├── skills/
│   │   └── loader.ts         # Parse SKILL.md files
│   └── channels/
│       ├── discord.ts        # Discord bot
│       └── cli.ts            # Terminal REPL
```

## Tools

Built-in tools:

- `read_file` - Read file contents
- `write_file` - Write content to a file
- `edit_file` - Edit with string replacement
- `execute_command` - Run shell commands
- `glob_files` - Find files by pattern
- `memory_search` - Search memories
- `memory_get` - Retrieve a specific memory

## Commands

```bash
bun run dev         # Start with --watch
bun run start       # Production start
bun run cli         # Direct CLI mode
bun test            # Run tests
```

## License

MIT
