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
bun run start xmpp             # XMPP/Jabber chat
bun run start api              # HTTP REST API server
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
├── agent/
│   ├── context-window.test.ts      # Token counting, message fitting, truncation
│   ├── context-summarizer.test.ts  # Conversation summarization
│   └── session-mutex.test.ts       # Concurrent session serialization
├── browser/
│   └── targeting.test.ts           # Accessibility element targeting
├── channels/
│   ├── discord-events.test.ts      # Discord event state management
│   └── discord-formatting.test.ts  # Message formatting, tool call rendering
├── config/
│   └── loader.test.ts              # Config loading, path expansion, defaults
├── conversation/
│   └── store.test.ts               # Conversation persistence
├── memory/
│   ├── search.test.ts              # Cosine similarity, FTS, vector, hybrid search
│   ├── indexer.test.ts             # SQLite storage, embedding vectors
│   ├── retrieval.test.ts           # Proactive memory retrieval
│   ├── extractor.test.ts           # Fact auto-extraction
│   ├── log-indexer.test.ts         # Log indexing
│   └── compaction-flush.test.ts    # Database maintenance
├── providers/
│   ├── llamacpp-format.test.ts     # llama.cpp response parsing
│   ├── anthropic-format.test.ts    # Anthropic format handling
│   ├── registry.test.ts            # Provider registry
│   ├── key-pool.test.ts            # API key rotation
│   └── error-classify.test.ts      # Error categorization
├── routing/
│   ├── model-router.test.ts        # Router decisions, complexity, task detection
│   ├── escalation.test.ts          # Low confidence, uncertainty patterns
│   ├── heuristics.test.ts          # Keyword detection, complexity estimation
│   └── rules.test.ts               # Rule creation, always-local/remote
├── safety/
│   ├── command-filter.test.ts      # Dangerous command blocking
│   ├── path-guard.test.ts          # Path sandboxing
│   └── safety-check.test.ts        # Safety check orchestration
├── skills/
│   ├── parser.test.ts              # YAML frontmatter parsing
│   └── loader.test.ts              # Filesystem skill discovery
├── standup/
│   ├── gather.test.ts              # Workspace context gathering
│   └── index.test.ts               # Standup exports
├── tasks/
│   ├── store.test.ts               # SQLite task CRUD
│   ├── cron.test.ts                # Cron expression parsing
│   ├── schedule.test.ts            # Interval parsing, business hours
│   ├── heartbeat.test.ts           # Periodic task pulse
│   └── error-classify.test.ts      # Task error categorization
├── tools/
│   ├── format.test.ts              # Tool call parsing, JSON handling
│   ├── executor.test.ts            # Tool execution, error handling
│   └── web-research.test.ts        # URL validation, HTML stripping, truncation
├── tracking/
│   ├── stats.test.ts               # Request counting, escalation tracking
│   └── costs.test.ts               # Model pricing, cost calculation
├── util/
│   ├── tokens.test.ts              # Token counting, message estimation
│   ├── async.test.ts               # Async utilities
│   └── logger.test.ts              # Log levels, entry storage, filtering
├── workflows/
│   └── engine.test.ts              # Workflow execution
└── fixtures/
    └── skills/                     # Test skill files
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

- `src/index.ts` — Entry point, parses command and dispatches to runner
- `src/bootstrap.ts` — Shared `AppServices` factory
- `src/commands/` — Command runners (cli, discord, xmpp, api, claude-code, status)
- `src/agent/` — Core conversation loop, context management, summarization
- `src/api/` — HTTP REST server (chat, tools, memory, stats endpoints)
- `src/browser/` — Playwright browser automation
- `src/channels/` — User interfaces (CLI, Discord, Claude Code, XMPP, API)
- `src/config/` — Configuration loading and validation
- `src/conversation/` — Conversation persistence (SQLite)
- `src/memory/` — Hybrid search memory system with embeddings
- `src/providers/` — LLM provider implementations
- `src/routing/` — Local vs remote routing decisions
- `src/safety/` — Command filtering, path sandboxing, audit logging
- `src/skills/` — Skill loading and management
- `src/standup/` — Workspace context gathering
- `src/tasks/` — Background task scheduler and event sources
- `src/tools/` — 48 built-in tools across 8 categories
- `src/tracking/` — Usage stats, cost tracking, transcript logging
- `src/ui/` — 256-color ANSI theme system
- `src/workflows/` — Workflow engine for structured multi-step tasks

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
- `@xmpp/client` — XMPP/Jabber protocol client
- `discord.js` — Discord bot framework
- `openai` — OpenAI API client
- `playwright` — Browser automation (for browser tools)
- `smol-toml` — TOML parser
- `yaml` — YAML parsing (for skill frontmatter)

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
2. Create a command runner in `src/commands/my-channel.ts`
3. Add a command case in `src/index.ts`
4. Wire up agent loop and providers in the command handler
