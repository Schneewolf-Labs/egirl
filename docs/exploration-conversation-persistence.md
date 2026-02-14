# Exploration: Conversation Persistence

## Current State

Conversations are fully ephemeral. The `AgentContext` object holds messages in an in-memory array that exists only for the lifetime of an agent loop execution.

### How It Works Today

1. **CLI mode**: A single `AgentLoop` instance is created at startup. Each `agent.run()` call appends to the same `context.messages` array, so multi-turn works within a single CLI session. On process exit, everything is lost.

2. **Discord mode**: A single `AgentLoop` instance handles all messages. Every Discord message goes through `agent.run()`, which appends to the same shared context. This means all Discord messages share one conversation — there's no per-channel or per-thread isolation, and everything is lost on restart.

3. **Claude Code mode**: Session persistence is handled externally by the Claude Agent SDK. The `resumeSession(sessionId, prompt)` method in `claude-code.ts` already supports this via the SDK.

### Key Files

| File | Role |
|------|------|
| `src/agent/context.ts` | `AgentContext` interface, `createAgentContext()`, `addMessage()` |
| `src/agent/loop.ts` | `AgentLoop` class — owns the context, runs the chat loop |
| `src/agent/context-window.ts` | `fitToContextWindow()` — trims messages to fit token budget |
| `src/channels/cli.ts` | CLI channel — calls `agent.run()` per user input |
| `src/channels/discord.ts` | Discord channel — calls `agent.run()` per Discord message |
| `src/memory/indexer.ts` | SQLite patterns already in codebase (reference for schema design) |
| `src/providers/types.ts` | `ChatMessage` type — what gets serialized |

## What Persistence Would Solve

1. **Survive restarts**: Resume a conversation after process restart (deployment, crash, upgrade)
2. **Discord context isolation**: Per-channel or per-thread conversation histories instead of one shared context
3. **Conversation history**: Review past interactions, debug agent behavior
4. **Context loading**: Start a new session with relevant recent context pre-loaded

## Design Considerations

### What Gets Stored

The `ChatMessage` type is the unit of persistence:

```typescript
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_call_id?: string
  tool_calls?: ToolCall[]
}
```

System prompts should NOT be stored — they're rebuilt from workspace files at startup and may change between sessions.

Tool call results can be large (file contents, command output). Options:
- **Store everything**: Simple, but DB grows fast
- **Store truncated**: Cap tool results at a reasonable size (e.g., 4KB)
- **Store metadata only**: Store tool name + success/failure, not full output

Recommendation: store everything, add a periodic cleanup job later if needed. Premature optimization here adds complexity for no current benefit.

### Session Identity

Currently `sessionId` is a random UUID generated at agent creation. For persistence, sessions need stable identifiers tied to their source:

| Channel | Session Key | Rationale |
|---------|-------------|-----------|
| CLI | Single session or explicit `--session <name>` | One user, one terminal |
| Discord DM | `discord:dm:{userId}` | Each DM is a distinct conversation |
| Discord channel | `discord:channel:{channelId}` | Per-channel history |
| Discord thread | `discord:thread:{threadId}` | Per-thread history |

### Storage Backend

The codebase already uses `bun:sqlite` for the memory system. Using the same approach for conversations is natural:

- Same database file (`memory.db`) or separate file (`conversations.db`)
- Recommendation: **separate file** (`conversations.db`) — conversations are high-write, append-heavy workload vs. memory's read-heavy, update-in-place pattern. Separate files also make it easy to clear conversation history without touching memories.

### Proposed Schema

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,           -- e.g., 'discord:dm:12345' or UUID
  channel TEXT NOT NULL,         -- 'cli', 'discord', 'claude-code'
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,            -- 'user', 'assistant', 'tool'
  content TEXT NOT NULL,         -- JSON string for ContentPart[] or plain text
  tool_calls TEXT,               -- JSON string of ToolCall[] if present
  tool_call_id TEXT,             -- For tool result messages
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_session ON messages(session_id, id);
```

No FTS or embeddings needed — conversations are accessed sequentially by session, not searched semantically. If conversation search becomes useful later, it can be added via the existing memory system (summarize conversations into memories).

### Loading Strategy

On session resume, messages need to fit the context window. Two approaches:

1. **Load all, trim at send time** (current approach via `fitToContextWindow`): Load all messages into `AgentContext.messages`, let the existing context window logic drop old ones. Simple, works today.

2. **Load recent N messages**: Query only the most recent messages from SQLite. More efficient for long-running sessions, but duplicates the trimming logic.

Recommendation: approach 1. The existing `fitToContextWindow` already handles this correctly. Load everything, let it trim. If sessions get extremely long (thousands of messages), add a cap on load later.

### Session Lifecycle

```
Session Start:
  1. Determine session key from channel context
  2. Check if session exists in DB
  3. If exists: load messages into AgentContext
  4. If not: create new session record

During Conversation:
  5. After each agent.run(), persist new messages to DB
     (user message + all assistant/tool messages from that turn)

Session End:
  6. Update last_active_at
  7. No explicit "close" needed — sessions are implicitly
     continued on next message
```

### Write Strategy

Messages should be written after each complete `agent.run()` cycle, not after each individual message append. This keeps the write path simple and avoids partial writes if the agent loop fails mid-execution.

A transaction wrapping all messages from one `run()` call ensures atomicity:

```typescript
db.transaction(() => {
  for (const msg of newMessages) {
    insertMessage(sessionId, msg)
  }
  updateSessionLastActive(sessionId)
})()
```

## Implementation Approach

### New Module: `src/conversation/`

```
src/conversation/
  store.ts        -- ConversationStore class (SQLite operations)
  session.ts      -- Session management (create, load, resolve key)
  index.ts        -- Public exports
```

### Changes to Existing Code

**`src/agent/context.ts`**:
- No changes to the interface — `AgentContext` stays the same
- Add a `createAgentContextWithHistory(config, sessionId, messages)` factory that pre-populates messages

**`src/agent/loop.ts`**:
- `AgentLoop` gets an optional `ConversationStore` dependency
- After `run()` completes, persist the new messages added during that call
- Track which messages are "new" (added since last persist) via an index marker

**`src/channels/cli.ts`**:
- Resolve session key (default: `cli:default`, or from `--session` flag)
- Pass `ConversationStore` to agent loop
- Add `/clear` command to reset conversation (delete session from DB)
- Add `/history` command to show past messages

**`src/channels/discord.ts`**:
- Resolve session key from message context (DM vs channel vs thread)
- Pass `ConversationStore` to agent loop
- Handle the fact that one `AgentLoop` is shared — either:
  - **(a)** Create per-session `AgentLoop` instances (more isolated, more memory)
  - **(b)** Swap context on the shared loop before each `run()` (less memory, more complex)

Recommendation: **(a)** — create agent loops per session. The `AgentLoop` is lightweight (just holds a context + references to providers/tools). A `Map<string, AgentLoop>` keyed by session ID works fine for a single-user system.

**`src/index.ts`**:
- Create `ConversationStore` during startup
- Pass it through to channels/agent loop
- Close store on shutdown

**`src/config/schema.ts`**:
- Optional: add conversation config section for max session age, max messages per session, etc.
- Can skip this for v1 and use sensible defaults

### What NOT to Change

- The memory system stays separate — it's for explicit knowledge, not conversation replay
- `fitToContextWindow` stays as-is — it already handles the "too many messages" case
- Provider types stay the same — `ChatMessage` is the serialization format
- Routing logic is unaffected

## Scope Estimate

This is a moderate-sized change touching ~6 files with ~2 new files:

- `src/conversation/store.ts` — ~120 lines (SQLite CRUD)
- `src/conversation/session.ts` — ~50 lines (key resolution)
- `src/agent/loop.ts` — ~30 lines changed (persist after run)
- `src/channels/cli.ts` — ~20 lines changed (session key, commands)
- `src/channels/discord.ts` — ~40 lines changed (per-session loops)
- `src/index.ts` — ~15 lines changed (store creation, plumbing)

## Open Questions

1. **Session expiry**: Should old sessions auto-expire? A 30-day TTL with cleanup on startup seems reasonable, but could also just leave everything and let the user clear manually.

2. **Discord per-channel vs per-thread**: Discord threads are child channels. Should a thread inherit the parent channel's conversation, or start fresh? Starting fresh (per-thread) seems more intuitive.

3. **CLI session naming**: Should CLI default to a single persistent session (`cli:default`) that survives restarts, or should each CLI invocation be a new session? A single persistent session with a `/new` command to start fresh feels right.

4. **Max loaded messages**: When loading a session with 500+ messages, should we cap at the most recent N (e.g., 200) before passing to `fitToContextWindow`? This would be a performance optimization — probably not needed for v1 but worth considering.

5. **Migration**: The memory DB is at `{workspace}/memory.db`. Should conversations go in the same DB (simpler deployment) or a separate `conversations.db` (cleaner separation)? Leaning toward separate.
