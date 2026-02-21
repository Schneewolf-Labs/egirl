# Agent Loop, Execution & Memory Persistence — Analysis

Deep analysis of egirl's core agent loop, tool execution pipeline, and memory persistence layer. Identifies architectural gaps, race conditions, and improvement opportunities.

---

## Architecture Overview

The agent operates as a **turn-based loop** with up to `maxTurns` (default 10) iterations per `run()` call. Each turn: infer → check escalation → handle tool calls or emit final response. Persistence happens after the loop completes.

```
User Input → Channel → SessionMutex → AgentLoop.doRun()
  → Memory Retrieval → Routing → [Turn Loop] → Persist → Auto-Extract
```

### Key Files

| Component | File | Lines |
|-----------|------|-------|
| Agent loop | `src/agent/loop.ts` | 174–547 |
| Context window | `src/agent/context-window.ts` | 246–341 |
| Context summarizer | `src/agent/context-summarizer.ts` | 73–117 |
| Session mutex | `src/agent/session-mutex.ts` | 13–56 |
| Conversation store | `src/conversation/store.ts` | 18–243 |
| Memory manager | `src/memory/index.ts` | 52–379 |
| Memory indexer (SQLite) | `src/memory/indexer.ts` | 42–458 |
| Memory search | `src/memory/search.ts` | 122–298 |
| Memory retrieval | `src/memory/retrieval.ts` | 28–91 |
| Memory extractor | `src/memory/extractor.ts` | 58–270 |
| Compaction flush | `src/memory/compaction-flush.ts` | 49–193 |
| Working memory | `src/memory/working.ts` | 32–195 |
| Memory GC | `src/memory/gc.ts` | 33–87 |
| Tool executor | `src/tools/executor.ts` | 13–182 |

---

## 1. Agent Loop Gaps

### 1.1 Fire-and-Forget Compaction Race Condition

**Location**: `loop.ts:722–750` (`triggerCompaction`) and `loop.ts:757–787` (`flushDroppedToMemory`)

Both context summarization and pre-compaction memory flush are fire-and-forget. If the user sends another message before compaction completes, the next turn's `chatWithContextWindow()` reads `this.context.conversationSummary` which hasn't been updated yet. This means:

- The **same dropped messages** could be summarized twice if two turns trigger compaction before the first finishes.
- The compaction summary may write to `conversationStore.updateSummary()` while the next turn is concurrently reading it.
- Pre-compaction memory flush calls `this.memory?.set()` in a loop with `await` inside a `.then()` chain — if the agent loop is already on its next turn, both the loop and the flush are writing to the same SQLite database (memory.db) concurrently.

**Severity**: Medium. SQLite WAL mode handles concurrent writes at the DB level, but the application-level state (`this.context.conversationSummary`) has no synchronization.

**Recommendation**: Track an in-flight compaction promise. Before triggering a new compaction, `await` or cancel the previous one. Alternatively, use the `SessionMutex` to prevent overlap — but it currently only gates `doRun()`, not fire-and-forget work spawned inside it.

### 1.2 No Hard Loop Termination

**Location**: `loop.ts:262–441`

The tool loop detection at `loop.ts:357–364` only **warns** the model with a user-role message when it detects repeated identical tool calls. It does not:

- Force-terminate after N repeated calls
- Track near-duplicate calls (same tool, slightly different args)
- Track non-identical but semantically equivalent loops (e.g., read → write → read → write cycle)

If the local model ignores the warning (common with smaller models), it will burn through all `maxTurns` in a useless loop.

**Severity**: Medium. Wastes compute and context window. The default 10-turn limit caps the damage, but a loop of 10 tool executions (each potentially running shell commands) is still problematic.

**Recommendation**: Add a hard limit — force-break after 3 repeated identical tool calls. For near-duplicates, consider a similarity threshold on args.

### 1.3 No Token Budget Tracking Across Turns

**Location**: `loop.ts:302–303`

Token usage is accumulated in `totalUsage` for the response, but there's no running budget check. If the model produces expensive tool results that bloat context, the loop doesn't know it's approaching budget limits until `fitToContextWindow` has to aggressively trim on the next turn.

**Severity**: Low. `fitToContextWindow` handles it gracefully, but the agent could preemptively decide "I'm running low on context, let me wrap up" rather than discovering it mid-turn.

### 1.4 Escalation Re-analyzes Response It Already Checked

**Location**: `loop.ts:402–408`

When a tool result sets `suggest_escalation`, the code calls `analyzeResponseForEscalation(response, ...)` again on the **same LLM response** that was already checked at line 324. The tool's escalation suggestion is the trigger, but the decision is based on re-analyzing the LLM response (not the tool result). This means the escalation decision after a tool suggestion is based on stale/irrelevant data.

**Severity**: Low. The escalation happens anyway because the tool suggested it, but the `confidence` and `reason` in the logged `EscalationDecision` are misleading.

**Recommendation**: When a tool suggests escalation, construct an `EscalationDecision` directly from the tool's reason/confidence instead of re-running `analyzeResponseForEscalation`.

### 1.5 Planning Mode Has No Tool Budget for Execution Phase

**Location**: `loop.ts:448–476` and `cli.ts:269–323`

When the user approves a plan, the CLI calls `agent.run('Approved. Execute the plan...', { maxTurns: 20 })`. This hardcoded 20-turn limit is the only constraint. There's no way for the planning phase to inform the execution phase about expected complexity or resource requirements.

**Severity**: Low. Works fine for most tasks but could be smarter.

---

## 2. Execution Pipeline Gaps

### 2.1 Parallel Tool Execution Silently Disabled

**Location**: `loop.ts:838–882` (`executeToolsWithHooks`)

Tools execute in parallel via `executeAll()` only when no event hooks or transcript logger is present. In practice, the CLI always provides event handlers and transcript is commonly enabled — meaning tools **always run sequentially** in most configurations.

```typescript
// loop.ts:842-844
if (!events?.onBeforeToolExec && !events?.onAfterToolExec && !this.transcript) {
  return this.executeTools(toolCalls)  // parallel
}
// Sequential fallback for everything else
```

**Severity**: Medium. Multi-tool turns (which are common — the model often calls read_file + glob_files together) take 2x+ longer than necessary. The sequential path exists purely for hook ordering, which could be achieved with `Promise.all` plus ordered event emission.

**Recommendation**: Execute tools in parallel even with hooks. Collect results, then emit events in call order after all complete.

### 2.2 Tool Result Truncation Double-Pass

**Location**: `loop.ts:394` (sync truncation) and `context-window.ts:269–274` (async truncation)

Tool results are truncated twice:
1. Sync at ingestion (`truncateToolResultSync`, char-ratio estimate)
2. Async in `fitToContextWindow` (with optional real tokenizer)

The first pass uses `chars/3.5` estimation, the second uses the real tokenizer. If the estimate is wrong, a result could pass the sync check but fail the async check (unlikely) or vice versa. More importantly, the sync pass at 8000 tokens means ~28KB of text — then `fitToContextWindow` may drop the entire message group anyway if the context is already tight.

**Severity**: Low. The double-pass is defensive and doesn't cause bugs, but the sync pass could be more aggressive for better context utilization.

### 2.3 No Tool Execution Timeout

**Location**: `tools/executor.ts:137–155`

Individual tool executions have no timeout. If `execute_command` spawns a process that hangs, or `web_research` hits a slow endpoint, the entire agent loop blocks indefinitely. The only escape is the `AbortSignal` checked between turns — but it's never checked *during* tool execution.

**Severity**: High. A single hanging tool call freezes the agent for all channels (due to the `SessionMutex`).

**Recommendation**: Add a configurable per-tool timeout (default 60s). The `execute_command` tool likely already has one, but the executor should enforce a hard upper bound.

### 2.4 Energy Budget Not Checked Before Tool Batch

**Location**: `executor.ts:118–133`

Energy is checked per individual tool call in `execute()`. But when `executeAll()` runs multiple tools in parallel, there's no pre-flight check for total energy cost. The agent could start 5 parallel tools, have the first 3 succeed and the last 2 fail energy checks — leaving the conversation in a partial state.

**Severity**: Low. Autonomous mode with energy budgets is opt-in and likely rare.

---

## 3. Memory Persistence Gaps

### 3.1 Working Memory Is Not Integrated Into the Agent Loop

**Location**: `src/memory/working.ts` (complete module) vs `src/agent/loop.ts`

`WorkingMemory` is a fully implemented TTL-based transient memory system with promotion support. However:

- The agent loop **never reads** working memory entries. The `buildContext()` method exists but is never called.
- No tool exposes working memory to the agent (memory tools only operate on the long-term `MemoryManager`).
- The `WorkingMemory` class is instantiated in `bootstrap.ts` but only stored — never injected into the agent loop.
- Promotion candidates (`getPromotionCandidates()`) are never processed.

**Severity**: High. An entire subsystem exists but is dead code. Working memory would solve the "remember this for the next hour" use case that currently requires polluting long-term memory.

**Recommendation**: Either wire it in or remove it. To wire it in:
1. Inject `WorkingMemory` into `AgentLoop` deps
2. Call `buildContext()` in `doRun()` and append to system prompt or inject as a message
3. Add `working_memory_set` / `working_memory_get` tools
4. Run `getPromotionCandidates()` periodically and promote to long-term

### 3.2 Memory GC Is Never Scheduled

**Location**: `src/memory/gc.ts`

`collectGarbage()` is a well-implemented function that prunes stale auto-extracted and conversation-source memories. But it's never called anywhere in the runtime:

- Not in bootstrap
- Not on a timer
- Not on startup
- Not exposed as a CLI command

Without GC, the memory DB grows unboundedly. Auto-extracted memories with `access_count=0` accumulate forever.

**Severity**: Medium. Won't cause problems for weeks/months, but eventually the memory store will be full of stale auto-extractions that dilute search quality.

**Recommendation**: Run GC on startup (or periodically via a background task). Add a `/gc` CLI command for manual invocation.

### 3.3 Conversation Persistence Is Append-Only Within a Run

**Location**: `loop.ts:504–515`

New messages are only persisted after the loop completes (`this.context.messages.slice(this.persistedIndex)`). If the process crashes mid-loop, all intermediate messages (user message, tool calls, tool results, partial assistant responses) are lost. The conversation resumes from wherever `persistedIndex` was at the start of the run.

**Severity**: Medium. A crash during a multi-turn tool execution loses all progress. The user has to re-explain what they wanted.

**Recommendation**: Persist incrementally — append the user message immediately at the start of `doRun()`, append tool call/result pairs after each tool execution. This adds SQLite writes but they're fast with WAL mode.

### 3.4 Auto-Extraction Has No Dedup for Key Collisions

**Location**: `loop.ts:888–929` and `extractor.ts`

The extractor generates snake_case keys like `preferred_language` or `api_redesign_decision`. The `memory.set()` call uses `ON CONFLICT(key) DO UPDATE`, so if two different conversations extract a memory with the same key, the second one silently **overwrites** the first.

The `checkDuplicate()` call at line 904 only checks **value similarity** via embeddings — it doesn't prevent key collisions between semantically different memories.

The `auto/` prefix helps namespace, but keys like `auto/preferred_language` could easily collide across sessions.

**Severity**: Medium. Over time, auto-extracted memories silently overwrite each other. The user never knows a memory was replaced.

**Recommendation**: Include session ID or timestamp in auto-generated keys: `auto/{sessionId}/{key}` or `auto/{timestamp}_{key}`.

### 3.5 Proactive Retrieval Uses Raw Char Budget, Not Token Budget

**Location**: `retrieval.ts:65`

```typescript
if (charCount + line.length > maxTokensBudget) break
```

The config param is called `maxTokensBudget` but the check compares **character count**, not token count. With the typical 3.5 chars/token ratio, a budget of 2000 "tokens" actually allows ~2000 characters (~570 tokens). The injected context is much smaller than intended.

**Severity**: Low-Medium. Memory recall is less useful than it could be because the budget is effectively 3.5x smaller than configured.

**Recommendation**: Either rename to `maxCharsBudget` (honest naming) or convert to actual token counting using the available tokenizer.

### 3.6 Embedding Cache Grows Without Bound

**Location**: `indexer.ts:238–256` (`getAllWithEmbeddings`)

The embedding cache (`this.embeddingCache`) loads **all** memories with embeddings into a `Map` on first access and is updated incrementally on writes. It's never evicted, even partially. With 2048-dimensional float32 embeddings, each entry costs ~8KB for the embedding alone.

At 10,000 memories: ~80MB of RAM just for embeddings. At 100,000: ~800MB.

**Severity**: Medium. Acceptable for small memory stores but will cause issues at scale. The single-user design caps growth somewhat, but auto-extraction generates many entries.

**Recommendation**: Add an LRU eviction policy or switch to an approximate nearest-neighbor index (e.g., HNSW). For v1, a simple size cap with oldest-eviction would suffice.

### 3.7 No Memory Versioning or History

**Location**: `indexer.ts:179–208` (`set` method)

`ON CONFLICT(key) DO UPDATE` silently replaces the old value. There's no version history, no diff, no audit trail of what a memory used to contain. If the agent or auto-extractor corrupts a memory, there's no way to recover the previous value.

**Severity**: Low. Single-user context makes this less critical, but it would be useful for debugging ("why does the agent think X?").

### 3.8 Conversation Store Has No Cross-Session Search

**Location**: `conversation/store.ts`

The store supports `loadMessages(sessionId)` and `listSessions()` but has no way to search across sessions. The agent can't answer "what did we discuss last week about the API redesign?" because:

- `loadMessages` requires knowing the exact session ID
- There's no FTS index on conversation messages
- Memories extracted from conversations are the only cross-session retrieval path

**Severity**: Low-Medium. The memory layer partially addresses this via auto-extraction, but detailed conversation context (exact messages, tool outputs) is inaccessible across sessions.

---

## 4. Concurrency & State Gaps

### 4.1 SessionMutex Doesn't Cover Background Work

**Location**: `session-mutex.ts:39–47`

The mutex only wraps `doRun()`. Fire-and-forget operations spawned inside `doRun()` (compaction, auto-extraction, memory flushes) continue running after the mutex is released. The next `doRun()` call can start while these background operations are still writing to shared state:

- `this.context.conversationSummary` (written by compaction)
- Memory SQLite DB (written by extraction and compaction flush)
- `conversationStore` (summary updates)

**Severity**: Medium. Most writes are to SQLite (which handles concurrency via WAL), but `this.context.conversationSummary` is a plain JS property with no synchronization.

### 4.2 Discord Session Map Has No Eviction

**Location**: `channels/discord.ts` — `sessions: Map<string, AgentLoop>`

Each unique Discord conversation creates a new `AgentLoop` instance stored in a `Map`. These are never evicted. Over time:

- Each session holds its full message history in memory
- Each session holds a tokenizer reference
- Each session holds its own memory/conversation store references

**Severity**: Low for single-user (bounded number of channels/threads), but would matter if egirl were ever used across many Discord servers.

---

## 5. Summary of Priorities

| # | Gap | Severity | Effort |
|---|-----|----------|--------|
| 3.1 | Working memory is dead code | High | Medium |
| 2.3 | No tool execution timeout | High | Low |
| 1.1 | Compaction race condition | Medium | Medium |
| 1.2 | No hard loop termination | Medium | Low |
| 2.1 | Parallel tool exec disabled | Medium | Medium |
| 3.2 | Memory GC never runs | Medium | Low |
| 3.3 | No incremental persistence | Medium | Medium |
| 3.4 | Auto-extraction key collisions | Medium | Low |
| 3.5 | Retrieval char/token mismatch | Low-Med | Low |
| 3.6 | Embedding cache unbounded | Medium | Medium |
| 4.1 | Mutex doesn't cover bg work | Medium | Medium |
| 3.8 | No cross-session search | Low-Med | High |
| 1.4 | Stale escalation re-analysis | Low | Low |
| 3.7 | No memory versioning | Low | Medium |
| 1.3 | No token budget tracking | Low | Medium |
| 2.2 | Double-pass truncation | Low | Low |
| 2.4 | Energy pre-flight check | Low | Low |
| 1.5 | Planning mode tool budget | Low | Low |
