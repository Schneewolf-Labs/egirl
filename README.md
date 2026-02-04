# egirl

A local-first AI agent framework that uses a local LLM for decision-making and task routing, escalating to cloud models (Claude, GPT) only when necessary for complex tasks.

## Features

- **Local-First**: The local LLM handles routing decisions, memory operations, simple conversations, and task decomposition
- **Smart Escalation**: Complex tasks (code generation, deep reasoning) automatically escalate to cloud models
- **OpenClaw Compatible**: Skills, workspace structure, and session format are compatible with OpenClaw ecosystem
- **Cost Aware**: Track savings from local execution vs what cloud would have cost

## Quick Start

```bash
# Install dependencies
bun install

# Copy and configure environment
cp .env.example .env
# Edit .env with your settings

# Run interactive chat
bun run egirl chat

# Or send a single message
bun run egirl chat -m "Hello, how are you?"

# Check status
bun run egirl status
```

## Configuration

Configuration is loaded from environment variables. See `.env.example` for all options.

### Local Model

The framework supports multiple local LLM backends:

- **llama.cpp** (default): `EGIRL_LOCAL_PROVIDER=llamacpp`
- **Ollama**: `EGIRL_LOCAL_PROVIDER=ollama`
- **vLLM**: `EGIRL_LOCAL_PROVIDER=vllm`

```bash
EGIRL_LOCAL_PROVIDER=llamacpp
EGIRL_LOCAL_ENDPOINT=http://localhost:8080
EGIRL_LOCAL_MODEL=default
```

### Remote Models (Optional)

For escalation to cloud models:

```bash
# Anthropic (Claude)
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
OPENAI_API_KEY=sk-...
```

### Routing

Control when tasks escalate to remote models:

```bash
EGIRL_DEFAULT_MODEL=local
EGIRL_ESCALATION_THRESHOLD=0.4
EGIRL_ALWAYS_LOCAL=memory_search,memory_get
EGIRL_ALWAYS_REMOTE=code_generation,code_review
```

## Architecture

```
egirl/
├── src/
│   ├── agent/          # Agent loop and context management
│   ├── channels/       # Input channels (CLI, Discord)
│   ├── config/         # Configuration loading
│   ├── gateway/        # WebSocket server (future)
│   ├── memory/         # Memory storage and search
│   ├── providers/      # LLM providers (local & remote)
│   ├── routing/        # Model routing decisions
│   ├── skills/         # Skill loading (OpenClaw compatible)
│   ├── tools/          # Built-in tools
│   ├── tracking/       # Usage and cost tracking
│   └── workspace/      # Workspace management
```

## Tools

Built-in tools available to the agent:

- `read_file` - Read file contents
- `write_file` - Write content to a file
- `edit_file` - Edit a file with string replacement
- `execute_command` - Run shell commands
- `glob_files` - Find files matching a pattern
- `memory_search` - Search stored memories
- `memory_get` - Retrieve a specific memory
- `memory_set` - Store a new memory

## Development

```bash
# Run in development mode with hot reload
bun run dev

# Run tests
bun test

# Type check
bunx tsc --noEmit
```

## License

MIT
