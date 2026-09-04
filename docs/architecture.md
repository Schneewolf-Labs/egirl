# Architecture

How egirl's components fit together, the data flow through the system, and the design decisions behind each layer.

## Mental Model

One local LLM is the operator. It escalates to **tools**, not to other models. The most important tool is `code_agent` — a wrapper around a configured coding agent backend such as Claude Code or Codex.

There is no model router, no remote LLM provider, no escalation target. When the local model can't do something itself, it calls a tool.

## System Overview

```
┌───────────────────────────────────────────────────┐
│                    Channels                       │
│  ┌─────┐ ┌────────┐ ┌────────────┐ ┌──────┐ ┌───┐ │
│  │ CLI │ │Discord │ │Claude Code │ │ XMPP │ │API│ │
│  └──┬──┘ └───┬────┘ └─────┬──────┘ └──┬───┘ └─┬─┘ │
│     └────────┼────────────┼───────────┼───────┘   │
│                    │                              │
│              ┌─────▼─────┐                        │
│              │ Agent Loop│                        │
│              └─────┬─────┘                        │
│                    │                              │
│         ┌──────────┼──────────┐                   │
│         ▼          ▼          ▼                   │
│    ┌─────────┐ ┌───────┐ ┌────────┐               │
│    │ Context │ │ Tools │ │ Safety │               │
│    └────┬────┘ └───┬───┘ └───┬────┘               │
│         │          │         │                    │
│    ┌────▼──────────▼─────────▼─────┐              │
│    │         llama.cpp provider    │              │
│    └───────────────────────────────┘              │
│                    │                              │
│              ┌─────▼─────┐                        │
│              │  Memory   │                        │
│              │ (SQLite + │                        │
│              │embeddings)│                        │
│              └───────────┘                        │
└───────────────────────────────────────────────────┘
```

Channels are thin adapters. The agent loop drives a single local provider, executes tool calls, and reads/writes memory. Tools like `code_agent` spawn a dedicated coding agent out-of-band, using the configured Claude Code or Codex backend.

## Request Lifecycle

A message from the user follows this path:

### 1. Channel receives input

Each channel is a thin adapter that converts its interface into a call to `AgentLoop.run()`. The chat transports (Discord, XMPP, Telegram, Matrix) own only their connection, allow-lists and wire format; everything after "a human said something" is the same turn on every surface and lives in the **channel spine** (`src/channels/spine.ts`): a pending report ask consuming the message as its answer, the typing indicator, tool-call narration (`narration.ts`), running the agent, chunking the reply to the transport's cap (`chunk.ts`), and turning a crash into an error message. A transport describes one conversation to `runTurn()` as a `Surface` — channel name, target, max length, narration format, a `send(chunk)` and an optional typing primitive — and the spine does the rest. The same `deliver()` backs each channel's outbound `send(target, message)`, so the task runner and the report tool see one shape everywhere.

- **CLI** (`src/channels/cli.ts`): readline-based interactive terminal. Supports single-message mode via `-m`.
- **Discord** (`src/channels/discord.ts`): discord.js bot responding to DMs and mentions. Filters by `allowed_channels` and `allowed_users`.
- **XMPP** (`src/channels/xmpp.ts`): XMPP/Jabber chat via `@xmpp/client`. Connects to a Prosody (or other XMPP) server. Filters by `allowed_jids`.
- **Telegram** (`src/channels/telegram.ts`): Telegram Bot API over long polling with built-in `fetch` (no library, no webhook). Filters by `allowed_users`.
- **Matrix** (`src/channels/matrix.ts`): Matrix chat over the raw client-server API (`fetch` + long-polling `/sync`, no SDK). Unencrypted rooms only. Filters by `allowed_users` and `allowed_rooms`.
- **Claude Code bridge** (`src/channels/claude-code.ts`): runs Claude Code directly and uses the local model to answer permission/clarification prompts. This is a channel, not the `code_agent` tool.
- **HTTP API** (`src/api.ts`): small Bun.serve handler exposing chat, memory, and task endpoints. Bound to localhost by default; optional bearer auth via `EGIRL_API_TOKEN`.

**Slash commands** (`src/session/commands.ts`) are one vocabulary on every surface and never reach the model: `/think <on|off|default>`, `/status`, `/context`, `/settings`, `/help`. They answer at once, even while a turn is running — the spine checks for one before the pending-ask broker or the agent see the text, Discord answers ahead of its per-channel queue, and the terminal answers mid-run instead of queueing — so `/status` is a way to ping the harness rather than the LLM. The terminal adds session-only commands (`/auto`, `/maxturns`, `/queue`, `/clear`, `/quit`, and the renderer's own `/plan`, `/compact`, `/wipe`, `/prompt`, `/debug`); on a chat surface those say so. The thinking setting itself lives on the session's `AgentLoop`, which is why `/think` from a room, the console's selector and `POST /sessions/:id/thinking` all change the same thing.

### 2. Agent loop processes the message

`AgentLoop.run()` is the conversation engine. The implementation is split across a few files:

- `src/agent/loop.ts` — entry point and run orchestration
- `src/agent/chat.ts` — single-turn chat, tool-call detection, continuation retries
- `src/agent/context.ts` — system prompt assembly from workspace files
- `src/agent/context-window.ts` — token-aware trimming
- `src/agent/context-summarizer.ts` — interior compaction when conversations get long
- `src/agent/session-mutex.ts` — serializes concurrent runs on the same session

Each turn:

1. Append the user message to the session context.
2. Fit the conversation to the provider's context window (trim or summarize as needed).
3. Send to the local llama.cpp provider.
4. If the model returns tool calls, run them and loop back to step 2 with the results.
5. When there are no more tool calls, return the final response.

The loop runs for up to `maxTurns` iterations to prevent infinite tool-calling loops.

### 3. Provider generates a response

There is one provider: `LlamaCppProvider` (`src/providers/llamacpp.ts`). It speaks the llama.cpp OpenAI-compatible HTTP API, parses Qwen3 `<tool_call>` XML tags (`src/providers/qwen3-format.ts`), and uses llama.cpp's `/tokenize` endpoint for accurate token counting (`src/providers/llamacpp-tokenizer.ts`). Stale-stream detection kills hung requests.

```typescript
interface LLMProvider {
  name: string
  chat(request: ChatRequest): Promise<ChatResponse>
}
```

### 4. Tool execution

When the provider returns tool calls, `ToolExecutor` (`src/tools/executor.ts`) looks each up in its registry and runs them concurrently via `Promise.all`. Each returns a `ToolResult`.

```typescript
interface ToolResult {
  success: boolean
  output: string
  isImage?: boolean
}
```

Tools never throw — errors come back as `{ success: false, output: "..." }` so the model can react.

A few tools are worth calling out:

- **`code_agent`** (`src/tools/builtin/code-agent/`) — delegates engineering work to the configured backend: Claude Code via `@anthropic-ai/claude-agent-sdk` or Codex via its interactive CLI. Each backend is one file implementing a shared `CodeAgentBackend` contract, dispatched by provider. This is the primary delegation surface for project work.
- **`execute_command`** (`src/tools/builtin/exec.ts`) — shell access, gated by the safety layer.

### 5. Safety layer

Tool calls pass through `src/safety/` before executing:

- `command-filter.ts` — block dangerous shell commands (configurable via `blocked_patterns`, allow mode via `extra_allowed`)
- `path-guard.ts` — optional filesystem sandbox
- `sensitive-files.ts` — block `.env`, SSH keys, credential files
- `permission-rules.ts` — pattern-based allow/deny rules for specific tool+argument shapes
- `audit.ts` — JSONL audit log of every tool call
- `prompt-injection.ts` — scans tool outputs for prompt-injection patterns

These are guardrails, not a sandbox — assume the local model is trusted and the user is the only principal. See [safety.md](safety.md).

### 6. Context window management

`fitToContextWindow()` in `src/agent/context-window.ts` ensures the conversation fits within the provider's token limit. It uses the llama.cpp tokenizer endpoint for accurate counts and drops oldest messages first (keeping the system prompt).

When interior compaction is enabled, long conversations are summarized mid-history via `context-summarizer.ts` instead of dropped, preserving continuity.

## Module Dependency Graph

```
src/index.ts (entry point — parses command, dispatches to runner)
├── commands/        → command runners (cli, discord, xmpp, telegram, matrix, api, claude-code, serve, status)
├── bootstrap.ts     → shared AppServices factory
│   ├── config/      → loads egirl.toml + .env → RuntimeConfig
│   ├── workspace/   → bootstraps ~/.egirl/workspace with templates
│   ├── providers/   → creates the llama.cpp provider
│   ├── tools/       → creates ToolExecutor with builtin tools
│   ├── memory/      → creates MemoryManager (SQLite + embeddings)
│   ├── safety/      → creates safety checkers
│   ├── tracking/    → creates StatsTracker / opens the trace store
│   ├── tasks/       → creates TaskStore + TaskRunner for background work
│   └── conversation/→ creates ConversationStore for persistence
├── agent/           → creates AgentLoop (orchestrates everything above)
├── api.ts           → HTTP API (chat, memory, tasks)
└── channels/        → CLI / Discord / XMPP / Telegram / Matrix / Claude Code bridge
```

Dependencies flow downward. Channels depend on the agent loop; nothing depends on channels.

## Key Interfaces

### ChatMessage

The universal message format:

```typescript
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_call_id?: string
  tool_calls?: ToolCall[]
}
```

### AgentContext

Holds the full conversation state for a session:

```typescript
interface AgentContext {
  systemPrompt: string    // Built from workspace personality files + tool list
  messages: ChatMessage[] // Conversation history
  workspaceDir: string    // Path to ~/.egirl/workspace
  sessionId: string       // UUID for this session
}
```

The system prompt is assembled from `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `USER.md`, plus the list of available tools.

## Directory Structure

```
egirl/
├── src/
│   ├── index.ts              # Entry point
│   ├── bootstrap.ts          # Shared AppServices factory
│   ├── api.ts                # HTTP API (Bun.serve)
│   ├── agent/
│   │   ├── loop.ts           # Agent run orchestration
│   │   ├── chat.ts           # Single-turn chat + continuations
│   │   ├── background.ts     # Background-task agent variant
│   │   ├── context.ts        # System prompt assembly
│   │   ├── context-window.ts # Token-aware context trimming
│   │   ├── context-summarizer.ts # Interior compaction
│   │   ├── token-budget.ts   # Budget tracking
│   │   ├── session-mutex.ts  # Serializes concurrent runs
│   │   └── events.ts         # Lifecycle event handlers
│   ├── browser/
│   │   ├── manager.ts        # Playwright session management
│   │   └── targeting.ts      # Accessibility-based element targeting
│   ├── channels/
│   │   ├── cli.ts            # Terminal interface
│   │   ├── cli-commands.ts   # Terminal-only commands (/plan, /wipe, /compact, ...)
│   │   ├── cli-events.ts     # Event rendering
│   │   ├── spine.ts          # Shared chat turn: slash commands, broker, typing, narration, chunking
│   │   ├── narration.ts      # Compact tool-call lines prefixed to chat replies
│   │   ├── chunk.ts          # Split replies to a transport's message cap
│   │   ├── discord.ts        # Discord bot
│   │   ├── discord/          # Passive-channel batch evaluator
│   │   ├── claude-code.ts    # Claude Code bridge channel
│   │   ├── xmpp.ts           # XMPP/Jabber chat
│   │   ├── telegram.ts       # Telegram Bot API (long polling)
│   │   └── matrix.ts         # Matrix chat (raw client-server API)
│   ├── commands/             # Command runners for each entry mode
│   ├── config/
│   │   ├── schema.ts         # TypeBox schema for egirl.toml
│   │   └── index.ts          # Config loading + validation
│   ├── conversation/
│   │   └── store.ts          # SQLite conversation persistence
│   ├── energy/               # Energy-budget system for tool calls
│   ├── memory/
│   │   ├── index.ts          # MemoryManager (public API)
│   │   ├── files.ts          # MEMORY.md + daily logs + images
│   │   ├── indexer.ts        # SQLite storage + FTS
│   │   ├── search.ts         # Hybrid search (FTS + vector)
│   │   ├── retrieval.ts      # Proactive memory retrieval
│   │   ├── extractor.ts      # Auto-extraction of facts
│   │   ├── log-indexer.ts    # Indexes stdout logs as memories
│   │   ├── compaction-flush.ts # Database maintenance
│   │   ├── working.ts        # Working-memory scratchpad
│   │   ├── gc.ts             # Garbage collection
│   │   └── embeddings/       # qwen3-vl / llamacpp / openai
│   ├── providers/
│   │   ├── types.ts          # LLMProvider, ChatMessage, etc.
│   │   ├── llamacpp.ts       # Local model via llama.cpp
│   │   ├── llamacpp-tokenizer.ts
│   │   ├── qwen3-format.ts   # Qwen3 tool call parsing
│   │   └── error-classify.ts
│   ├── safety/
│   │   ├── index.ts          # Orchestration
│   │   ├── command-filter.ts # Shell command blocking / allow-list
│   │   ├── path-guard.ts     # Path sandboxing
│   │   ├── sensitive-files.ts
│   │   ├── permission-rules.ts # Pattern-based tool rules
│   │   ├── prompt-injection.ts
│   │   └── audit.ts          # JSONL audit logging
│   ├── skills/
│   │   ├── types.ts
│   │   ├── parser.ts         # Markdown + YAML frontmatter
│   │   ├── loader.ts         # Filesystem discovery
│   │   ├── index.ts          # SkillManager registry
│   │   └── bundled/          # Ships-with-egirl skills
│   ├── standup/
│   │   ├── gather.ts         # Workspace context gathering
│   │   └── index.ts
│   ├── tasks/
│   │   ├── store.ts          # SQLite-backed task CRUD
│   │   ├── runner.ts         # Execution engine
│   │   ├── discovery.ts      # Idle-time work finding
│   │   ├── heartbeat.ts      # Periodic pulse
│   │   ├── schedule.ts       # Interval parsing, business hours
│   │   ├── cron.ts           # Cron expression support
│   │   └── events/           # File, webhook, GitHub, command event sources
│   ├── tools/
│   │   ├── types.ts          # Tool, ToolResult interfaces
│   │   ├── executor.ts       # Registry + concurrent execution
│   │   ├── format.ts         # Qwen3 <tool_call> parsing
│   │   └── builtin/
│   │       ├── read.ts / write.ts / edit.ts / glob.ts
│   │       ├── exec.ts       # execute_command
│   │       ├── memory.ts     # memory_* tools
│   │       ├── git.ts        # git_* tools
│   │       ├── github/       # gh_* tools (pr, issue, ci, release, branch)
│   │       ├── browser.ts    # browser_* tools
│   │       ├── tasks.ts      # task_* tools
│   │       ├── screenshot.ts
│   │       ├── web-research.ts
│   │       ├── web-search.ts # SearxNG-backed
│   │       └── code-agent/   # Code agent delegation (claude, codex backends)
│   ├── tracking/             # Stats, trace store, session journal
│   ├── ui/
│   │   └── theme.ts          # 256-color ANSI theme system
│   ├── util/
│   │   ├── logger.ts
│   │   ├── tokens.ts
│   │   ├── args.ts
│   │   └── async.ts
│   └── workspace/            # Workspace bootstrapping
├── services/embeddings/      # Python Qwen3-VL-Embedding service (optional)
├── test/                     # bun:test suite (mirrors src/)
├── workspace/                # Default personality templates
├── docs/                     # Documentation
├── scripts/                  # Utility scripts
├── egirl.toml                # Main configuration
└── .env                      # Secrets (not committed)
```

## Design Decisions

### Why no router?

egirl used to route between a local and remote provider. That's gone. The model is the planner — if it needs more capability, it calls `code_agent` as a tool. One chooser, one delegation surface, no chat-provider escalation logic to debug.

### Why Qwen3 native tool-call format?

`<tool_call>` XML tags match the Qwen3 chat template exactly: the model generates tool calls reliably without format confusion, fine-tuning uses the same format as pre-training, and no post-processing layer sits between the model and the tool executor. See [tool-format.md](tool-format.md).

### Why SQLite for memory?

`bun:sqlite` is zero-dependency, in-process, and supports FTS5 natively. Vector search is done in application code using cosine similarity over `Float32Array`s — no vector database at this scale. See [memory.md](memory.md).

### Why a channel spine but no channel registry?

Channels share plumbing, not a plugin layer. The spine (`src/channels/spine.ts`) exists because four chat transports had grown four copies of the same turn — broker check, typing refresh, narration, chunking, error reply — and each copy drifted (Telegram had no typing indicator; Discord's error text differed from everyone else's). What they share is the turn, so that is what is shared. What they do not share is discovery: CLI, Discord, XMPP, Telegram, Matrix, the Claude Code bridge, and the HTTP API are hardcoded and constructed by name in `serve.ts`; adding a fifth means writing a fifth and adding it to the list — the extensibility point is the HTTP API, not an in-process plugin layer.

### Why no streaming?

The agent loop needs the complete response to detect tool calls. Streaming would require buffering partial responses, detecting incomplete tool calls across chunks, and managing state — complexity that isn't worth it for a single-user tool. Continuation retries handle truncated responses (`src/agent/chat.ts`).
