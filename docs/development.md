# Development Guide

How to set up a development environment, run tests, and work with the codebase.

## Prerequisites

- [Bun](https://bun.sh) (runtime and package manager)
- [llama.cpp](https://github.com/ggerganov/llama.cpp) server (for local model)
- Python 3.10+ (optional — only for the embeddings service)
- A GPU with enough VRAM for your chosen model

## Setup

```bash
git clone https://github.com/Schneewolf-Labs/egirl.git
cd egirl
bun install
bun run start init --provider codex
# Edit .env with your tokens if you use Discord/XMPP/GitHub/API.
```

Code agent authentication is separate from `.env`. For Claude Code, run `claude auth login` once. For Codex, authenticate the local `codex` CLI according to your Codex install. egirl does not need `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for either path.

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
bun run start xmpp             # XMPP/Jabber chat
bun run start telegram         # Telegram bot
bun run start api              # HTTP REST API server
bun run start claude-code      # Claude Code bridge (alias: cc)
bun run start serve            # Discord/XMPP/Telegram + background task runner in one process
bun run start status           # Check connections
```

### Starting the Local Model

```bash
# Chat model
llama-server -m your-model.gguf -c 32768 --port 8080 -ngl 99

# Embedding model (optional — enables memory)
# Easiest: use the bundled Python service
./scripts/serve-embeddings.sh

# Or run llama.cpp with an embedding model
llama-server \
  -m Qwen.Qwen3-VL-Embedding-2B.Q8_0.gguf \
  --mmproj mmproj-Qwen.Qwen3-VL-Embedding-2B.f16.gguf \
  -c 8192 --port 8082 --embedding -ngl 99
```

## Testing

Tests use `bun:test` and live in the `test/` directory, mirroring `src/`.

```bash
bun test                          # all tests
bun test test/agent/loop.test.ts  # one file
bun test --watch                  # watch mode
```

Always run the full verification suite before pushing:

```bash
bun test
bun run lint
bun run typecheck
```

All three must pass.

### Test Structure

```
test/
├── agent/
│   ├── context-window.test.ts        # Token counting, message fitting
│   ├── context-summarizer.test.ts    # Interior compaction
│   ├── continuation.test.ts          # Continuation retries
│   ├── interior-compaction.test.ts
│   ├── post-response-validation.test.ts
│   ├── session-mutex.test.ts
│   ├── system-prompt-caching.test.ts
│   └── token-budget.test.ts
├── api.test.ts                       # HTTP API endpoints
├── browser/
│   └── targeting.test.ts
├── channels/
│   ├── discord-events.test.ts
│   └── discord-formatting.test.ts
├── config/
│   └── loader.test.ts
├── conversation/
│   └── store.test.ts
├── energy/                           # Energy-budget accounting
├── memory/
│   ├── search.test.ts
│   ├── indexer.test.ts
│   ├── retrieval.test.ts
│   ├── extractor.test.ts
│   ├── log-indexer.test.ts
│   └── compaction-flush.test.ts
├── providers/
│   ├── llamacpp-format.test.ts
│   ├── error-classify.test.ts
│   └── stale-stream.test.ts
├── safety/
│   ├── command-filter.test.ts
│   ├── path-guard.test.ts
│   └── safety-check.test.ts
├── skills/
│   ├── parser.test.ts
│   └── loader.test.ts
├── standup/
│   ├── gather.test.ts
│   └── index.test.ts
├── tasks/
│   ├── store.test.ts
│   ├── cron.test.ts
│   ├── schedule.test.ts
│   ├── heartbeat.test.ts
│   └── error-classify.test.ts
├── tools/
│   ├── format.test.ts
│   ├── executor.test.ts
│   ├── executor-energy.test.ts
│   ├── deferred-loader.test.ts
│   ├── browser.test.ts
│   ├── git.test.ts
│   ├── web-research.test.ts
│   └── web-search.test.ts
├── tracking/
│   └── stats.test.ts
├── util/
│   └── (logger, tokens, async)
└── fixtures/
    └── skills/
```

### Writing Tests

- Test behavior, not implementation.
- Mock at module boundaries (providers, file system), not internal functions.
- Use descriptive test names that explain the scenario.
- One file per module.

```typescript
import { describe, test, expect } from 'bun:test'

describe('AgentLoop', () => {
  test('stops when the model returns no tool calls', () => {
    // ...
  })
})
```

## Project Structure

See [architecture.md](architecture.md) for the full breakdown. Key points:

- `src/index.ts` — entry point; parses the command and dispatches
- `src/bootstrap.ts` — shared `AppServices` factory
- `src/commands/` — command runners (cli, discord, xmpp, telegram, api, claude-code, serve, status)
- `src/agent/` — conversation loop, context management, summarization
- `src/api.ts` — minimal HTTP API (Bun.serve)
- `src/browser/` — Playwright browser automation
- `src/channels/` — user interfaces (CLI, Discord, XMPP, Telegram, Claude Code bridge)
- `src/config/` — config loading and TypeBox validation
- `src/conversation/` — conversation persistence (SQLite)
- `src/energy/` — energy-budget accounting for tool calls
- `src/memory/` — hybrid-search memory system with embeddings
- `src/providers/` — llama.cpp provider (the only one)
- `src/safety/` — command filtering, path sandboxing, audit, permission rules
- `src/skills/` — skill loading and management
- `src/standup/` — workspace context gathering
- `src/tasks/` — background task scheduler and event sources
- `src/tools/` — built-in tools (including `code_agent`)
- `src/tracking/` — usage stats, trace store, session journal
- `src/ui/` — 256-color ANSI theme system
- `src/workspace/` — workspace bootstrapping

## Code Style

### Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Files | kebab-case | `context-window.ts` |
| Types/Interfaces | PascalCase | `AgentContext` |
| Functions/Variables | camelCase | `fitToContextWindow` |
| True constants | SCREAMING_SNAKE | `DEFAULT_TIMEOUT` |
| Booleans | is/has/should/can prefix | `isEnabled`, `hasImages` |

### Patterns

- One file = one concept (~200 line target).
- Functions over classes unless you need stateful instances.
- Explicit dependencies via parameters, not module-level singletons.
- Early returns to reduce nesting.
- Named exports only (no default exports).
- `interface` for object shapes, not `type`.
- TypeBox for runtime validation, infer static types from schemas.
- `undefined` for absence (not `null`, except at external boundaries like SQLite).

### Patterns to Avoid

- No dependency injection frameworks.
- No decorators.
- No class inheritance (composition only).
- No default exports.
- No barrel exports within modules (only at module boundaries).
- No complex generics unless absolutely necessary.
- No `any` — use `unknown` and narrow.

### Error Handling

- Throw early, catch at boundaries (agent loop, channel handlers).
- Tool errors return `{ success: false, output: "..." }`, never throw.
- Use discriminated unions for expected failures, not exceptions.
- Never swallow errors silently — log at minimum.

## Configuration

See [configuration.md](configuration.md) for the full reference.

Key files:
- `egirl.toml` — application config
- `.env` — secrets
- `src/config/schema.ts` — TypeBox schema + `RuntimeConfig` interface
- `src/config/index.ts` — loading, merging, validation

## Dependencies

Keep the dependency list minimal. Before adding a new package:

1. Explain what you need it for.
2. List alternatives you considered.
3. Get approval.

Current production dependencies:

```
@anthropic-ai/claude-agent-sdk   # Claude Code backend for code_agent
@sinclair/typebox                # runtime schema validation
@xmpp/client                     # XMPP/Jabber protocol client
discord.js                       # Discord bot framework
node-pty                         # interactive Codex backend for code_agent
playwright                       # browser automation
smol-toml                        # TOML parser
yaml                             # YAML parsing (skill frontmatter)
```

No `@anthropic-ai/sdk`, no `openai`: there's no remote LLM provider in egirl. Code agents are invoked through local CLI/SDK integrations and use their own subscription or CLI auth.

## Git Conventions

### Commit Messages

Imperative mood, concise, no trailing period:

```
Add memory search tool
Fix heartbeat schedule parsing
Remove unused tracking code
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

- `SOUL.md` — personality definition
- `MEMORY.md` — long-term curated facts
- `USER.md` — user profile
- `IDENTITY.md` — name, emoji, identity config
- `AGENTS.md` — operating instructions

## Common Tasks

### Adding a New Tool

1. Create `src/tools/builtin/my-tool.ts` implementing the `Tool` interface.
2. Register it in `src/tools/builtin/index.ts`.
3. If it should be gated, add a toggle in `src/config/schema.ts` under `[tools]`.
4. Write tests in `test/tools/`.

### Adding a New Channel

Channels are hardcoded. If a fourth is genuinely wanted:

1. Create `src/channels/my-channel.ts`.
2. Create a command runner in `src/commands/my-channel.ts`.
3. Add a command case in `src/index.ts`.
4. Wire up the agent loop in the command handler.

Don't build a channel plugin system. The extensibility point is the HTTP API.
