# Development Guide

How to set up a development environment, run tests, and work with the codebase.

## Prerequisites

- [Bun](https://bun.sh) (runtime and package manager)
- [llama.cpp](https://github.com/ggerganov/llama.cpp) server (for local model)
- Python 3.10+ (optional — only for the embeddings service)
- A GPU with enough VRAM for your chosen model

## Setup

```bash
# Clone the repo
git clone https://github.com/Schneewolf-Labs/egirl.git
cd egirl

# Install dependencies
bun install

# Copy environment template
cp .env.example .env
# Edit .env with your API keys (optional)
```

## Running

### Development Mode

```bash
bun run dev
```

Runs with `--watch` — auto-restarts on file changes.

### Production Mode

```bash
bun run start cli              # Interactive CLI
bun run start discord          # Discord bot
bun run start claude-code      # Claude Code bridge
bun run start status           # Check connections
```

### Starting the Local Model

```bash
# Chat model
llama-server -m your-model.gguf -c 32768 --port 8080 -ngl 99

# Embedding model (optional, for memory system)
llama-server \
  -m Qwen.Qwen3-VL-Embedding-2B.Q8_0.gguf \
  --mmproj mmproj-Qwen.Qwen3-VL-Embedding-2B.f16.gguf \
  -c 8192 --port 8082 --embedding -ngl 99
```

## Testing

Tests use `bun:test` and live in the `test/` directory, mirroring the `src/` structure.

```bash
# Run all tests
bun test

# Run specific test file
bun test test/routing/model-router.test.ts

# Run with watch mode
bun test --watch
```

### Test Structure

```
test/
├── routing/
│   └── model-router.test.ts    # Router decisions, complexity, task detection
├── tools/
│   ├── format.test.ts          # Tool call parsing, JSON handling
│   └── executor.test.ts        # Tool execution, error handling
└── fixtures/
    └── skills/                 # Test skill files
```

### Writing Tests

- Test behavior, not implementation
- Mock at module boundaries (providers, file system), not internal functions
- Use descriptive test names that explain the scenario
- Keep test files focused — one file per module

```typescript
import { describe, test, expect } from 'bun:test'

describe('Router', () => {
  test('routes greetings to local', () => {
    // ...
  })

  test('routes code generation to remote', () => {
    // ...
  })
})
```

## Project Structure

See [architecture.md](architecture.md) for a detailed breakdown. Key points:

- `src/index.ts` — Entry point and CLI command routing
- `src/agent/` — Core conversation loop
- `src/providers/` — LLM provider implementations
- `src/routing/` — Local vs remote routing decisions
- `src/tools/` — Built-in tool implementations
- `src/memory/` — Hybrid search memory system
- `src/channels/` — User interfaces (CLI, Discord, Claude Code)
- `src/config/` — Configuration loading and validation

## Code Style

### Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Files | kebab-case | `model-router.ts` |
| Types/Interfaces | PascalCase | `RoutingDecision` |
| Functions/Variables | camelCase | `createRouter` |
| True constants | SCREAMING_SNAKE | `DEFAULT_TIMEOUT` |
| Booleans | is/has/should/can prefix | `isEnabled`, `hasImages` |

### Patterns

- One file = one concept (~200 line limit)
- Functions over classes unless you need stateful instances
- Explicit dependencies via parameters, not singletons
- Early returns to reduce nesting
- Named exports only (no default exports)
- `interface` for object shapes, not `type`
- TypeBox for runtime validation, infer static types from schemas
- `undefined` for absence (not `null`, except at external boundaries)

### Patterns to Avoid

- No dependency injection frameworks
- No decorators
- No class inheritance (composition only)
- No default exports
- No barrel exports within modules (only at module boundaries)
- No complex generics unless absolutely necessary
- No `any` — use `unknown` and narrow

### Error Handling

- Throw early, catch at boundaries (agent loop, channel handlers)
- Tool errors return `{ success: false, output: "..." }`, never throw
- Use discriminated unions for expected failures, not exceptions
- Never swallow errors silently — log at minimum

## Configuration

See [configuration.md](configuration.md) for the full reference.

Key files:
- `egirl.toml` — Application config (workspace, models, routing, channels)
- `.env` — API keys and secrets
- `src/config/schema.ts` — TypeBox schema definition
- `src/config/defaults.ts` — Default values

## Dependencies

Keep the dependency list minimal. Before adding a new package:

1. Explain what you need it for
2. List alternatives you considered
3. Get approval

Current production dependencies:
- `@anthropic-ai/claude-agent-sdk` — Claude Code integration
- `@anthropic-ai/sdk` — Claude API client
- `@sinclair/typebox` — Runtime schema validation
- `discord.js` — Discord bot framework
- `openai` — OpenAI API client
- `smol-toml` — TOML parser

## Git Conventions

### Commit Messages

Imperative mood, concise, no period:

```
Add memory search tool
Fix escalation threshold logic
Remove unused provider config
```

### Branch Names

```
feature/thing
fix/thing
refactor/thing
```

Batch related changes into single commits.

## Sacred Files

These workspace files are user data — never modify without explicit permission:

- `SOUL.md` — Personality definition
- `MEMORY.md` — Long-term curated facts
- `USER.md` — User profile
- `IDENTITY.md` — Name, emoji, identity config
- `AGENTS.md` — Operating instructions

## Common Tasks

### Adding a New Tool

1. Create `src/tools/builtin/my-tool.ts` implementing the `Tool` interface
2. Register it in `src/tools/builtin/index.ts`
3. Add to the tool list in `src/agent/context.ts` (system prompt)
4. Write tests in `test/tools/`

### Adding a New Provider

1. Create `src/providers/my-provider.ts` implementing `LLMProvider`
2. Register it in `src/providers/index.ts`
3. Add config schema fields in `src/config/schema.ts`

### Adding a New Channel

1. Create `src/channels/my-channel.ts`
2. Add a command case in `src/index.ts`
3. Wire up agent loop and providers in the command handler
