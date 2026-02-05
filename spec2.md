# egirl — Local-First AI Agent for Schneewolf Labs

## What This Is

egirl is a personal AI agent built for a single power user running a fat GPU cluster (200GB+ VRAM). It is NOT a general-purpose framework. It does NOT need to support arbitrary users, channels, or deployment patterns. It talks to you on Discord and from the terminal, runs most things locally on llama.cpp, and escalates to Claude/GPT only when the task genuinely requires it.

This is a Schneewolf Labs project. It should feel like Schneewolf — opinionated, fast, no cruft.

## Design Philosophy

1. **One user, one cluster.** No auth, no pairing, no multi-user anything.
2. **Local by default.** Every routing decision, memory query, and simple conversation runs on YOUR hardware at zero API cost.
3. **Escalate, don't apologize.** When local can't cut it, hand off to Claude seamlessly — don't make the user ask.
4. **Flat and readable.** Minimal abstraction. If you can grep for it, don't wrap it in three layers of interface.
5. **Steal good ideas.** OpenClaw's skill format is great — use it. Their workspace layout is great — use it. Their 50-layer gateway abstraction is not — don't.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Local LLM**: llama.cpp HTTP server (OpenAI-compatible API). No Ollama wrapper, no vLLM — talk to llama.cpp directly.
- **Remote LLMs**: `@anthropic-ai/sdk`, `openai` npm packages
- **Database**: `bun:sqlite` for memory indexing
- **Embeddings**: llama.cpp serving an embedding model (e.g., nomic-embed-text)
- **Discord**: `discord.js`
- **Config**: TOML (`smol-toml`), validated with TypeBox

## Directory Structure

```
egirl/
├── package.json
├── tsconfig.json
├── bunfig.toml
├── egirl.toml                    # Main config file
├── .env                          # Secrets only (API keys, Discord token)
├── README.md
│
├── src/
│   ├── index.ts                  # Entry: load config → start channels
│   ├── config.ts                 # Load egirl.toml + .env, validate, export typed config
│   │
│   ├── agent/
│   │   ├── loop.ts               # The core loop: route → execute → maybe escalate → respond
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
│   │   ├── read.ts               # Read file contents
│   │   ├── write.ts              # Write file
│   │   ├── edit.ts               # str_replace style edit
│   │   ├── exec.ts               # Run shell command
│   │   ├── glob.ts               # Find files by pattern
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
│   │   ├── discord.ts            # Discord bot: listen for DMs/mentions → feed to agent loop
│   │   └── cli.ts                # Interactive terminal REPL for testing
│   │
│   ├── tracking/
│   │   └── usage.ts              # Count tokens, estimate costs saved, log escalations
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

## Config (egirl.toml)

```toml
[workspace]
path = "~/.egirl/workspace"

[local]
endpoint = "http://localhost:8080"      # llama.cpp server
model = "qwen2.5-32b-instruct"         # for display/logging only
context_length = 32768
max_concurrent = 2                      # you have the VRAM for parallel requests

[local.embeddings]
endpoint = "http://localhost:8081"      # separate llama.cpp instance for embeddings
model = "nomic-embed-text-v1.5"

[routing]
default = "local"
escalation_threshold = 0.4             # confidence below this triggers escalation
always_local = ["memory_search", "memory_get", "greeting", "acknowledgment"]
always_remote = ["code_generation", "code_review", "complex_reasoning"]

[channels.discord]
allowed_channels = ["dm"]               # or specific channel IDs
allowed_users = ["YOUR_DISCORD_ID"]

[skills]
dirs = ["~/.egirl/skills", "{workspace}/skills"]
```

Secrets go in `.env`:
```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DISCORD_TOKEN=...
```

## Core Interfaces

### LLM Provider (src/providers/types.ts)

```typescript
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatResponse {
  content: string;
  tool_calls?: ToolCall[];
  usage: { input_tokens: number; output_tokens: number };
  confidence?: number; // local model only, 0-1
  model: string;
}

export interface LLMProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}
```

All three providers (llamacpp, anthropic, openai) implement this single interface. No base class, no factory pattern. Just three files that each export a class with a `chat` method.

### Router (src/router/router.ts)

```typescript
export interface RoutingDecision {
  target: "local" | "remote";
  provider?: string; // e.g. "anthropic" — only set when target is "remote"
  reason: string;
  confidence: number;
}

export class Router {
  constructor(
    private config: RoutingConfig,
    private local: LLMProvider,
  ) {}

  async route(message: string, context: ConversationContext): Promise<RoutingDecision>;
}
```

Routing is a two-step process:
1. **Heuristics** (src/router/heuristics.ts): Pattern matching. No LLM call. Checks `always_local`, `always_remote`, regex patterns for code requests, etc. Returns a decision with confidence. If confidence > 0.9, use it.
2. **LLM classification** (only if heuristics are uncertain): Ask the LOCAL model to classify the task as `{ type, complexity }` using a short structured prompt. Apply routing rules to the classification.

The router itself never calls remote APIs. Routing decisions are always free.

### Escalation (src/router/escalation.ts)

```typescript
export class EscalationDetector {
  shouldEscalate(
    response: ChatResponse,
    toolResults?: ToolResult[],
  ): { escalate: boolean; reason?: string };
}
```

Checks after local model responds:
- Confidence below threshold
- Response contains hedging patterns ("I'm not sure", "I can't", "this requires")
- Tool execution failed and local model can't recover
- User explicitly asks ("use claude", "escalate", "try harder")

When escalation triggers, the agent loop replays the conversation to the remote provider with the local model's attempt included as context.

### Agent Loop (src/agent/loop.ts)

```typescript
export class AgentLoop {
  constructor(
    private router: Router,
    private escalation: EscalationDetector,
    private local: LLMProvider,
    private remote: Map<string, LLMProvider>,
    private tools: ToolRegistry,
    private memory: MemoryManager,
    private usage: UsageTracker,
  ) {}

  async run(input: string, session: Session): Promise<string>;
}
```

The loop:
1. Record user message to today's memory log
2. Route: local or remote?
3. Build system prompt (AGENTS.md + SOUL.md + IDENTITY.md + relevant memory + active skills)
4. Call the chosen provider
5. If local → check escalation → if triggered, replay to remote
6. If response has tool calls → execute tools → feed results back → loop (max 10 iterations)
7. Record assistant response to today's memory log
8. Return final response text

### Tools (src/tools/types.ts)

```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolResult {
  success: boolean;
  output: string;
  suggest_escalation?: boolean;
  escalation_reason?: string;
}

export interface Tool {
  definition: ToolDefinition;
  execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult>;
}
```

Each tool is one file. No base class. Export a `definition` and an `execute` function.

### Memory (src/memory/manager.ts)

Two layers:
- **MEMORY.md**: Long-term facts. Curated. The local model can update this.
- **memory/YYYY-MM-DD.md**: Daily session logs. Append-only during the day.

Search uses SQLite FTS5 for keyword search + vector similarity from local embeddings. Results are merged and ranked. All memory operations run locally — zero API cost.

On session start, load today's log + yesterday's log into context. For older context, the model uses the `memory_search` tool.

### Skills (src/skills/types.ts)

```typescript
export interface Skill {
  name: string;
  description: string;
  content: string; // SKILL.md body (after frontmatter)
  metadata: {
    // OpenClaw-compatible
    openclaw?: {
      requires?: { bins?: string[]; env?: string[] };
    };
    // egirl-specific
    egirl?: {
      complexity: "local" | "remote" | "auto";
      can_escalate?: boolean;
    };
  };
}
```

Skills are loaded from SKILL.md files with YAML frontmatter. The format is compatible with OpenClaw/ClawHub so you can grab community skills. The `egirl.complexity` field tells the router whether this skill needs a big model.

### Channels

**Discord** (src/channels/discord.ts): Connects via discord.js. Listens for DMs and mentions in allowed channels. Feeds messages into the agent loop. Posts responses back. Handles message splitting for long responses.

**CLI** (src/channels/cli.ts): readline-based REPL. For testing and direct interaction. Prints routing decisions and cost stats inline.

## What NOT to Build

- No WebSocket gateway. Discord.js handles its own connection. CLI is stdio.
- No channel abstraction layer. Discord and CLI are hardcoded. If you add Telegram later, add a file.
- No plugin system for providers. Three files, three classes. Add a fourth when you need one.
- No skill gating/permissions. You control what's installed on your machine.
- No session persistence across restarts (for v1). Memory files are the persistence layer.
- No streaming (for v1). Get the loop working first, add streaming later.
- No multi-user anything. One user. One config. One workspace.

## Implementation Order

### Phase 1: Talk to Me (get a response flowing)
1. `src/config.ts` — load egirl.toml + .env
2. `src/providers/llamacpp.ts` — call llama.cpp's `/v1/chat/completions`
3. `src/agent/context.ts` — read workspace markdown files, build system prompt
4. `src/agent/loop.ts` — minimal: build prompt → call local → return response
5. `src/channels/cli.ts` — readline REPL
6. `src/index.ts` — wire it all together

**Milestone**: `bun run dev` → type a message → get a response from local LLM.

### Phase 2: Route and Escalate
7. `src/providers/anthropic.ts` — Claude client
8. `src/providers/openai.ts` — OpenAI client
9. `src/router/heuristics.ts` — pattern matching rules
10. `src/router/router.ts` — heuristics → optional LLM classification → decision
11. `src/router/escalation.ts` — check local response quality
12. Update `src/agent/loop.ts` — add routing + escalation to the loop

**Milestone**: Simple messages stay local. "Write me a Python script" escalates to Claude.

### Phase 3: Tools
13. `src/tools/types.ts` + `src/tools/registry.ts`
14. `src/tools/executor.ts` — execute tool calls from model responses
15. `src/tools/read.ts`, `write.ts`, `edit.ts`, `exec.ts`, `glob.ts`
16. Update `src/agent/loop.ts` — add tool call loop

**Milestone**: Agent can read files, run commands, and edit code.

### Phase 4: Memory
17. `src/memory/manager.ts` — read/write MEMORY.md and daily logs
18. `src/memory/embeddings.ts` — get vectors from llama.cpp embedding server
19. `src/memory/indexer.ts` — chunk markdown, store in SQLite with FTS5 + vectors
20. `src/memory/search.ts` — hybrid BM25 + cosine similarity
21. `src/tools/memory.ts` — `memory_search` and `memory_get` tools

**Milestone**: Agent remembers things across sessions. Search works.

### Phase 5: Skills
22. `src/skills/loader.ts` — parse SKILL.md files from skill directories
23. Update `src/agent/context.ts` — inject relevant skills into system prompt

**Milestone**: Drop a SKILL.md into the skills folder, agent picks it up.

### Phase 6: Discord
24. `src/channels/discord.ts` — discord.js bot, message handling, response posting

**Milestone**: Talk to egirl on Discord. Same brain, different mouth.

### Phase 7: Polish
25. `src/tracking/usage.ts` — token counts, cost tracking, escalation stats
26. Better error handling throughout
27. Graceful shutdown
28. Tests for router and tools

## Commands

```bash
bun run dev         # Start with --watch
bun run start       # Production start
bun run cli         # Direct CLI mode (skip Discord)
bun test            # Run tests
```

## Notes

- llama.cpp serves an OpenAI-compatible API at `/v1/chat/completions`. Use that. Don't implement a custom protocol.
- For embeddings, llama.cpp serves `/v1/embeddings` when loaded with an embedding model. Run it as a second instance on a different port.
- Bun's native SQLite (`bun:sqlite`) is fast and built-in. Use it directly, no ORM.
- The workspace files (AGENTS.md, SOUL.md, etc.) are the personality and configuration. The agent reads them on every request. Edit them to change behavior.
- Escalation log (`.egirl/escalation.jsonl`) tracks every escalation event. Use this data to tune routing rules over time.
- Keep provider implementations thin. The llama.cpp client is ~100 lines. The Anthropic client is ~80 lines. If a provider file gets big, you're overcomplicating it.
