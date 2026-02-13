# Architecture

This document describes how egirl's components fit together, the data flow through the system, and the design decisions behind each layer.

## System Overview

```
┌──────────────────────────────────────────────────┐
│                    Channels                       │
│  ┌─────────┐  ┌──────────┐  ┌─────────────────┐  │
│  │   CLI   │  │ Discord  │  │  Claude Code     │  │
│  └────┬────┘  └────┬─────┘  └───────┬─────────┘  │
│       │            │                │             │
│       └────────────┼────────────────┘             │
│                    │                              │
│              ┌─────▼─────┐                        │
│              │ Agent Loop │                        │
│              └─────┬─────┘                        │
│                    │                              │
│         ┌──────────┼──────────┐                   │
│         ▼          ▼          ▼                   │
│    ┌────────┐ ┌────────┐ ┌────────┐              │
│    │ Router │ │ Tools  │ │Context │              │
│    └───┬────┘ └───┬────┘ └───┬────┘              │
│        │          │          │                    │
│   ┌────▼──────────▼──────────▼─────┐             │
│   │           Providers            │             │
│   │  ┌──────────┐  ┌────────────┐  │             │
│   │  │ llama.cpp│  │Anthropic/  │  │             │
│   │  │ (local)  │  │OpenAI      │  │             │
│   │  └──────────┘  └────────────┘  │             │
│   └────────────────────────────────┘             │
│                    │                              │
│              ┌─────▼─────┐                        │
│              │  Memory   │                        │
│              │ (SQLite + │                        │
│              │ Embeddings)│                        │
│              └───────────┘                        │
└──────────────────────────────────────────────────┘
```

## Request Lifecycle

A message from the user follows this path:

### 1. Channel receives input

The channel (CLI, Discord, or Claude Code) receives raw user input. Each channel is a thin adapter that converts its interface into a call to `AgentLoop.run()`.

- **CLI** (`src/channels/cli.ts`): readline-based interactive terminal. Supports single-message mode via `-m`.
- **Discord** (`src/channels/discord.ts`): discord.js bot responding to DMs and @mentions. Filters by `allowed_channels` and `allowed_users`.
- **Claude Code** (`src/channels/claude-code.ts`): bridges to Claude Code via `@anthropic-ai/claude-agent-sdk`. Uses the local model to handle tool permissions and answer clarifying questions.

### 2. Agent loop processes the message

`AgentLoop.run()` in `src/agent/loop.ts` is the core conversation engine:

1. Adds the user message to the context
2. Asks the Router where to send it (local or remote)
3. Fits the conversation to the provider's context window
4. Sends to the chosen provider
5. Checks for escalation (if local provider responded with low confidence)
6. If tool calls are returned, executes them and loops back to step 3
7. When no more tool calls, returns the final response

The loop runs for up to `maxTurns` iterations (default: 10) to prevent infinite tool-calling loops.

### 3. Router decides local vs remote

The `Router` class (`src/routing/model-router.ts`) combines two strategies:

- **Heuristics** (`src/routing/heuristics.ts`): keyword matching against the user's message. Code-related keywords push toward remote; greetings stay local.
- **Rules** (`src/routing/rules.ts`): configurable priority-based rules from `egirl.toml`. Tasks like `memory_search` are always local; `code_generation` always goes remote.

The combined result is a `RoutingDecision` with a `target` (local/remote), `reason`, and `confidence` score.

### 4. Provider generates a response

Providers implement the `LLMProvider` interface (`src/providers/types.ts`):

```typescript
interface LLMProvider {
  name: string
  chat(request: ChatRequest): Promise<ChatResponse>
}
```

Three implementations exist:

- **LlamaCppProvider** (`src/providers/llamacpp.ts`): HTTP client for the llama.cpp OpenAI-compatible API. Parses `<tool_call>` XML tags from Qwen3 responses. Creates a tokenizer endpoint for accurate token counting.
- **AnthropicProvider** (`src/providers/anthropic.ts`): Wraps `@anthropic-ai/sdk`. Used as the primary escalation target.
- **OpenAIProvider** (`src/providers/openai.ts`): Wraps the `openai` npm package. Used as fallback if Anthropic is not configured.

### 5. Tool execution

When the provider returns tool calls, the `ToolExecutor` (`src/tools/executor.ts`) runs them:

1. Parses tool calls from the response (format depends on provider)
2. Looks up each tool by name in its registry
3. Executes all calls concurrently via `Promise.all`
4. Returns a `Map<string, ToolResult>` with results keyed by call ID

Tool results include a `suggest_escalation` flag — if a tool detects it needs more capability (e.g., `edit_file` can't find the target text), it can recommend escalating to a remote provider.

### 6. Escalation

Mid-conversation escalation can happen two ways:

- **Post-response analysis** (`src/routing/escalation.ts`): After the local model responds, `shouldRetryWithRemote()` checks for uncertainty patterns, low confidence, or insufficient responses. If triggered, the agent switches providers and retries.
- **Tool-suggested escalation**: A tool can set `suggest_escalation: true` in its result, prompting the agent to switch to the remote provider for the next turn.

### 7. Context window management

`fitToContextWindow()` in `src/agent/context-window.ts` ensures the conversation fits within the provider's token limit:

- Uses the llama.cpp tokenizer endpoint for accurate local token counts
- Drops oldest messages first (keeps system prompt and recent context)
- If the server reports a different `n_ctx` than configured, retrims and retries once

## Module Dependency Graph

```
src/index.ts (entry point)
├── config/          → loads egirl.toml + .env → RuntimeConfig
├── workspace/       → bootstraps ~/.egirl/workspace with templates
├── providers/       → creates LLMProvider instances from config
├── routing/         → creates Router from config rules
├── tools/           → creates ToolExecutor with builtin tools
├── memory/          → creates MemoryManager (SQLite + embeddings)
├── tracking/        → creates StatsTracker for usage metrics
├── agent/           → creates AgentLoop (orchestrates everything above)
└── channels/        → creates channel (CLI/Discord/Claude Code)
```

Dependencies flow downward. The agent loop depends on the router, tools, and providers. Channels depend on the agent loop. Nothing depends on channels — they are leaf nodes.

## Key Interfaces

### ChatMessage

The universal message format shared across all providers:

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
  systemPrompt: string    // Built from workspace personality files
  messages: ChatMessage[] // Conversation history
  workspaceDir: string    // Path to ~/.egirl/workspace
  sessionId: string       // UUID for this session
}
```

The system prompt is assembled from workspace files: `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, and `USER.md`. Tool descriptions are appended automatically.

### ToolResult

Every tool returns this:

```typescript
interface ToolResult {
  success: boolean
  output: string
  isImage?: boolean               // For screenshot tool
  suggest_escalation?: boolean    // Hint to switch to remote
  escalation_reason?: string
}
```

## Directory Structure

```
egirl/
├── src/
│   ├── index.ts              # Entry point, CLI command routing
│   ├── agent/
│   │   ├── loop.ts           # Core agent loop
│   │   ├── context.ts        # System prompt + conversation state
│   │   ├── context-window.ts # Token-aware context trimming
│   │   └── events.ts         # Lifecycle event handlers
│   ├── channels/
│   │   ├── cli.ts            # Terminal interface
│   │   ├── discord.ts        # Discord bot
│   │   └── claude-code.ts    # Claude Code bridge
│   ├── config/
│   │   ├── schema.ts         # TypeBox schema for egirl.toml
│   │   ├── index.ts          # Config loading + validation
│   │   └── defaults.ts       # Default values
│   ├── memory/
│   │   ├── index.ts          # MemoryManager (public API)
│   │   ├── files.ts          # MEMORY.md + daily logs + images
│   │   ├── indexer.ts        # SQLite storage + FTS
│   │   ├── search.ts         # Hybrid search (FTS + vector)
│   │   └── embeddings.ts     # Embedding providers
│   ├── providers/
│   │   ├── types.ts          # LLMProvider, ChatMessage, etc.
│   │   ├── llamacpp.ts       # Local model via llama.cpp
│   │   ├── anthropic.ts      # Claude API
│   │   └── openai.ts         # OpenAI API
│   ├── routing/
│   │   ├── model-router.ts   # Router class
│   │   ├── heuristics.ts     # Keyword-based analysis
│   │   ├── rules.ts          # Priority-based routing rules
│   │   └── escalation.ts     # Post-response escalation checks
│   ├── skills/
│   │   ├── types.ts          # Skill, SkillMetadata interfaces
│   │   ├── parser.ts         # Markdown + YAML frontmatter parsing
│   │   ├── loader.ts         # Filesystem skill discovery
│   │   └── index.ts          # SkillManager registry
│   ├── tools/
│   │   ├── types.ts          # Tool, ToolResult interfaces
│   │   ├── executor.ts       # ToolExecutor registry + execution
│   │   ├── format.ts         # Qwen3 <tool_call> parsing
│   │   ├── loader.ts         # Tool loading
│   │   └── builtin/          # 7 built-in tools
│   ├── tracking/
│   │   ├── stats.ts          # Request/token/cost tracking
│   │   └── costs.ts          # Model pricing lookup
│   └── util/
│       ├── logger.ts         # Colored, leveled console logging
│       ├── tokens.ts         # Token counting utilities
│       └── async.ts          # Async helpers
├── services/
│   └── embeddings/           # Python embedding service (optional)
├── test/                     # bun:test suite
├── workspace/                # Runtime data (templates)
├── docs/                     # Documentation
├── egirl.toml                # Main configuration
└── .env                      # API keys (not committed)
```

## Design Decisions

### Why no channel abstraction?

There are only three channels and they share nothing meaningful. CLI uses readline, Discord uses discord.js events, Claude Code uses the agent SDK stream. A shared interface would add indirection without reducing code.

### Why Qwen3 native format for tool calls?

Using `<tool_call>` XML tags matches the Qwen3 chat template exactly, which means:
1. The model generates tool calls reliably without format confusion
2. Fine-tuning data uses the same format the model was pre-trained on
3. No post-processing layer needed between the model and the tool executor

### Why SQLite for memory?

bun:sqlite is zero-dependency, runs in-process, and handles FTS5 (full-text search) natively. No external database to manage. Vector search is done in application code using cosine similarity over Float32Arrays — no need for a vector database at this scale.

### Why no streaming?

v1 intentionally skips streaming to keep the agent loop simple. The loop needs the complete response to check for tool calls and decide on escalation. Streaming would require buffering partial responses, detecting incomplete tool calls, and managing state across chunks — complexity that isn't worth it for a single-user tool.
