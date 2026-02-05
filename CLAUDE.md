# egirl — Local-First AI Agent for Schneewolf Labs

## Project Overview

egirl is a personal AI agent for a single power user running a fat GPU cluster (200GB+ VRAM). It talks via Discord and terminal, runs most things locally on llama.cpp, and escalates to Claude/GPT only when necessary.

**This is NOT** a general-purpose framework. No auth, no multi-user, no deployment patterns.

## Design Philosophy

1. **One user, one cluster** — No auth, no pairing, no multi-user anything
2. **Local by default** — Routing, memory, simple conversations run on YOUR hardware at zero API cost
3. **Escalate, don't apologize** — Hand off to Claude seamlessly when local can't cut it
4. **Flat and readable** — Minimal abstraction. If you can grep for it, don't wrap it
5. **Steal good ideas** — OpenClaw's skill format: yes. Their 50-layer gateway abstraction: no

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Bun |
| Language | TypeScript (strict mode) |
| Local LLM | llama.cpp HTTP server (OpenAI-compatible API) |
| Remote LLMs | `@anthropic-ai/sdk`, `openai` npm packages |
| Database | `bun:sqlite` for memory indexing |
| Embeddings | llama.cpp serving embedding model (e.g., nomic-embed-text) |
| Discord | `discord.js` |
| Config | TOML (`smol-toml`), validated with TypeBox |

## Directory Structure

```
egirl/
├── package.json
├── tsconfig.json
├── bunfig.toml
├── egirl.toml                    # Main config file
├── .env                          # Secrets only (API keys, Discord token)
│
├── src/
│   ├── index.ts                  # Entry: load config → start channels
│   ├── config.ts                 # Load egirl.toml + .env, validate, export typed config
│   │
│   ├── agent/
│   │   ├── loop.ts               # Core loop: route → execute → maybe escalate → respond
│   │   └── context.ts            # Build system prompt from workspace files
│   │
│   ├── router/
│   │   ├── router.ts             # Decide local vs remote for a given message
│   │   ├── escalation.ts         # Detect when local response needs remote followup
│   │   └── heuristics.ts         # Fast pattern-match rules (no LLM call needed)
│   │
│   ├── providers/
│   │   ├── types.ts              # LLMProvider interface, ChatMessage, ChatResponse
│   │   ├── llamacpp.ts           # llama.cpp HTTP client (chat + embeddings)
│   │   ├── anthropic.ts          # Claude client
│   │   └── openai.ts             # OpenAI client
│   │
│   ├── tools/
│   │   ├── registry.ts           # Tool registration and lookup
│   │   ├── types.ts              # Tool, ToolResult interfaces
│   │   ├── executor.ts           # Run a tool call, return result
│   │   ├── read.ts, write.ts, edit.ts, exec.ts, glob.ts
│   │   └── memory.ts             # memory_search, memory_get tools
│   │
│   ├── memory/
│   │   ├── manager.ts            # Read/write MEMORY.md and daily logs
│   │   ├── search.ts             # Hybrid search: BM25 (FTS5) + vector cosine similarity
│   │   ├── indexer.ts            # Index markdown chunks into SQLite
│   │   └── embeddings.ts         # Get embeddings from llama.cpp
│   │
│   ├── skills/
│   │   ├── loader.ts             # Scan skill dirs, parse SKILL.md frontmatter + body
│   │   └── types.ts              # Skill interface (OpenClaw-compatible metadata)
│   │
│   ├── channels/
│   │   ├── discord.ts            # Discord bot: DMs/mentions → agent loop
│   │   └── cli.ts                # Interactive terminal REPL
│   │
│   ├── tracking/
│   │   └── usage.ts              # Token counts, cost estimates, escalation logs
│   │
│   └── util/
│       ├── log.ts                # Structured logger (console, not a framework)
│       └── tokens.ts             # Rough token count estimation
│
├── workspace/                    # Default workspace (created on first run)
│   ├── AGENTS.md                 # Operating instructions
│   ├── SOUL.md                   # Personality
│   ├── IDENTITY.md               # Name, emoji
│   ├── USER.md                   # User profile
│   ├── MEMORY.md                 # Long-term curated facts
│   ├── TOOLS.md                  # Tool usage notes
│   ├── memory/                   # Daily logs: YYYY-MM-DD.md
│   ├── skills/                   # User-installed skills
│   └── .egirl/
│       ├── routing.toml          # Override routing rules
│       └── escalation.jsonl      # Escalation event log
│
└── test/
    ├── router.test.ts
    ├── tools.test.ts
    └── fixtures/
```

## Configuration

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
endpoint = "http://localhost:8081"      # separate llama.cpp for embeddings
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

## Core Interfaces

### LLM Provider

```typescript
interface LLMProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ChatResponse {
  content: string;
  tool_calls?: ToolCall[];
  usage: { input_tokens: number; output_tokens: number };
  confidence?: number; // local model only, 0-1
  model: string;
}
```

All providers implement this single interface. No base class, no factory pattern.

### Router

Two-step routing:
1. **Heuristics**: Pattern matching, no LLM call. Checks `always_local`, `always_remote`, regex patterns. If confidence > 0.9, use it.
2. **LLM classification**: Only if heuristics are uncertain. Ask LOCAL model to classify task complexity.

Router never calls remote APIs. Routing decisions are always free.

### Escalation

Checks after local model responds:
- Confidence below threshold
- Hedging patterns ("I'm not sure", "I can't")
- Tool execution failed and can't recover
- User explicitly asks ("use claude", "escalate")

When triggered, replay conversation to remote provider with local attempt as context.

### Agent Loop

1. Record user message to today's memory log
2. Route: local or remote?
3. Build system prompt (AGENTS.md + SOUL.md + IDENTITY.md + relevant memory + active skills)
4. Call the chosen provider
5. If local → check escalation → if triggered, replay to remote
6. If response has tool calls → execute tools → feed results back → loop (max 10 iterations)
7. Record assistant response to today's memory log
8. Return final response text

### Tools

```typescript
interface Tool {
  definition: ToolDefinition;
  execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult>;
}

interface ToolResult {
  success: boolean;
  output: string;
  suggest_escalation?: boolean;
  escalation_reason?: string;
}
```

Each tool is one file. Export a `definition` and an `execute` function.

### Memory

Two layers:
- **MEMORY.md**: Long-term curated facts. Model can update this.
- **memory/YYYY-MM-DD.md**: Daily session logs. Append-only.

Search uses SQLite FTS5 + vector similarity from local embeddings. All memory operations run locally.

### Skills

```typescript
interface Skill {
  name: string;
  description: string;
  content: string; // SKILL.md body
  metadata: {
    openclaw?: { requires?: { bins?: string[]; env?: string[] } };
    egirl?: { complexity: "local" | "remote" | "auto"; can_escalate?: boolean };
  };
}
```

Compatible with OpenClaw/ClawHub format.

## Implementation Phases

### Phase 1: Talk to Me
1. `config.ts` — load egirl.toml + .env
2. `providers/llamacpp.ts` — call llama.cpp `/v1/chat/completions`
3. `agent/context.ts` — read workspace markdown, build system prompt
4. `agent/loop.ts` — minimal loop
5. `channels/cli.ts` — readline REPL
6. `index.ts` — wire it together

**Milestone**: `bun run dev` → type message → get response from local LLM

### Phase 2: Route and Escalate
7. `providers/anthropic.ts`, `providers/openai.ts`
8. `router/heuristics.ts`, `router/router.ts`, `router/escalation.ts`
9. Update `agent/loop.ts` with routing + escalation

**Milestone**: Simple messages stay local. Code requests escalate to Claude.

### Phase 3: Tools
10. `tools/types.ts`, `tools/registry.ts`, `tools/executor.ts`
11. `tools/read.ts`, `write.ts`, `edit.ts`, `exec.ts`, `glob.ts`
12. Update `agent/loop.ts` with tool loop

**Milestone**: Agent can read files, run commands, edit code.

### Phase 4: Memory
13. `memory/manager.ts`, `memory/embeddings.ts`
14. `memory/indexer.ts`, `memory/search.ts`
15. `tools/memory.ts`

**Milestone**: Agent remembers across sessions. Search works.

### Phase 5: Skills
16. `skills/loader.ts`
17. Update `agent/context.ts` to inject skills

**Milestone**: Drop SKILL.md in folder, agent picks it up.

### Phase 6: Discord
18. `channels/discord.ts`

**Milestone**: Talk to egirl on Discord.

### Phase 7: Polish
19. `tracking/usage.ts`
20. Error handling, graceful shutdown, tests

## Commands

```bash
bun run dev         # Start with --watch
bun run start       # Production start
bun run cli         # Direct CLI mode (skip Discord)
bun test            # Run tests
```

## What NOT to Build

- No WebSocket gateway (Discord.js handles its connection, CLI is stdio)
- No channel abstraction layer (hardcode Discord and CLI)
- No plugin system for providers (three files, three classes)
- No skill gating/permissions
- No session persistence across restarts (v1)
- No streaming (v1)
- No multi-user anything

## Implementation Notes

- llama.cpp serves OpenAI-compatible API at `/v1/chat/completions` — use that
- Run embeddings as second llama.cpp instance on different port
- Use `bun:sqlite` directly, no ORM
- Workspace files (AGENTS.md, SOUL.md, etc.) are personality/config — read on every request
- Keep provider implementations thin (~80-100 lines each)
- Escalation log tracks events for tuning routing rules over time
