# Execution & Memory Loop Analysis — Gaps and Needed Features

Analysis of the core agent execution loop (`src/agent/loop.ts`), memory system (`src/memory/`), routing (`src/routing/`), context window management (`src/agent/context-window.ts`), and background task runner (`src/tasks/runner.ts`).

---

## Executive Summary

The architecture is solid — clean separation of concerns, defensive error handling, graceful degradation. No critical bugs. The gaps below fall into three buckets:

1. **Scaling limits** — brute-force vector search, unbounded memory growth, full-conversation re-extraction
2. **Missing feedback loops** — routing doesn't learn, memories don't decay, escalation is one-directional
3. **Operational blind spots** — tool output size at ingestion, memory recall accumulation, race conditions in async paths

---

## 1. Execution Loop

### 1.1 Tool results added to context without size checks

**Location**: `src/agent/loop.ts:351-355`

Tool results are added to the context array raw. Truncation only happens later during `fitToContextWindow()` on the *next* LLM call. If a turn produces multiple large tool outputs (e.g., `read_file` on a big file + `execute_command` with verbose output), they all accumulate before any truncation pass.

**Impact**: Within a single multi-tool turn, context can temporarily balloon. The model won't see the overflow (it gets truncated next call), but token counting for all messages runs each turn, wasting compute.

**Fix**: Truncate tool results at ingestion — apply `maxToolResultTokens` when adding to context, not just during window fitting.

### 1.2 Memory recall accumulates across turns

**Location**: `src/agent/loop.ts:188-217`

Each turn, `retrieveForContext()` injects recalled memories as a user message. Over a 10-turn conversation, this can add 10 separate recall blocks (up to 2000 chars each = 20KB of memories) before context fitting prunes them.

**Impact**: Wastes token budget on redundant recalls. The same memories can appear multiple times. Context window fitting handles the overflow, but it means real conversation messages get dropped to make room for stale recall blocks.

**Fix**: Either (a) deduplicate recalls across turns, (b) replace the previous recall block instead of appending, or (c) skip proactive recall on turns where tool results dominate.

### 1.3 Auto-extraction processes the full conversation every turn

**Location**: `src/agent/loop.ts:821-852`, `src/memory/extractor.ts:58-91`

`runAutoExtraction` passes `this.context.messages` (the entire conversation) to `extractMemories` every turn. The extractor condensates and sends the whole thing to the local LLM.

**Impact**: As conversations grow, extraction gets slower and re-processes already-extracted content. Key collision prevents duplicate *storage* (same key overwrites), but the LLM still does redundant analysis each turn.

**Fix**: Track the message index of the last extraction and only pass new messages since then. The extractor already filters for minimum user messages, so this wouldn't break the threshold logic.

### 1.4 Escalation is one-directional (local → remote only)

**Location**: `src/agent/loop.ts:290-322`, `src/routing/escalation.ts`

Once escalated to remote, the agent stays on the remote provider for the rest of the turn loop. There's no de-escalation path for simple follow-up messages after a complex task was handled.

**Impact**: A complex first question routes to Claude, and then every subsequent "thanks" or "rename that variable" also goes to Claude. Unnecessary API cost.

**Fix**: Re-route at the start of each `run()` call (which already happens — this is per-invocation). The issue is more about *within* a multi-turn tool loop. Consider re-evaluating routing if the conversation shifts from complex to trivial between tool calls. Low priority — the per-invocation routing already handles the common case.

### 1.5 Planning mode breaks if model calls tools on turn 1

**Location**: `src/agent/loop.ts:242, 388`

Planning mode withholds tools on `turns === 1` to force a text plan. But if the model still produces a tool call (possible with some providers that hallucinate tool calls), the plan response would come on turn 2+ and the `planningMode && turns === 1` check at line 388 would miss it, returning the plan without the `isPlan` flag.

**Impact**: Edge case — unlikely since tools aren't provided on turn 1. But if it happens, the plan would be treated as a final response, skipping the approval flow.

**Fix**: Track whether we're still in "planning phase" (no tools executed yet) rather than checking `turns === 1` specifically.

### 1.6 No guard against infinite tool loops

**Location**: `src/agent/loop.ts:238-415`

The `maxTurns` limit (default 10) is the only protection. A model that repeatedly calls the same tool with the same arguments would burn through all turns before hitting the limit.

**Impact**: Rare but wastes compute when it happens. The max turns fallback is graceful, but 10 round-trips of repeated tool calls is expensive on local compute.

**Fix**: Detect repeated identical tool calls (same name + same arguments) within a run and break the loop or inject a "you already called this tool with these arguments" message.

---

## 2. Memory System

### 2.1 Brute-force vector search — O(n) on every query

**Location**: `src/memory/search.ts:73-110`

`searchVector()` calls `this.indexer.getAllWithEmbeddings()`, loads every embedding into memory, and computes cosine similarity for each one. This is O(n) in both time and memory.

**Impact**: Fine for hundreds of memories. Becomes a bottleneck at thousands. At 10K memories with 2048-dim float32 vectors, that's ~80MB loaded per search query.

**Fix**: Two options:
- **Near-term**: Add an in-memory index (build once, update incrementally). Even a simple sorted list of embeddings cached between queries would help.
- **Medium-term**: Implement approximate nearest neighbor (ANN) — HNSW or IVF. There are pure-JS HNSW implementations, or use sqlite-vss.

### 2.2 FTS score normalization is rank-based, not relevance-based

**Location**: `src/memory/search.ts:63-67`

FTS scores are computed as `1 - index / results.length`. This means:
- 1 result → score = 0 (always)
- 2 results → scores are 1.0 and 0.5
- 10 results → first is 1.0, last is 0.1

The score depends on *how many results* are returned, not the actual relevance. This undermines hybrid scoring because the FTS component is unstable.

**Impact**: Hybrid search (30% FTS + 70% vector) is biased by result set size. A highly relevant FTS result in a set of 1 gets score 0, contributing nothing to hybrid.

**Fix**: Use SQLite FTS5's `rank` value (BM25) directly and normalize to 0-1 using min/max of the result set, or a fixed sigmoid. The FTS5 rank is already available from the query.

### 2.3 No memory decay, access tracking, or importance scoring

**Location**: `src/memory/indexer.ts` (schema)

All memories are treated equally. A stale auto-extracted fact from 6 months ago has the same weight in search as a critical decision from today. There's no tracking of when a memory was last accessed or how often it's been recalled.

**Impact**: As memory grows, old low-value entries pollute search results. Manual pruning via `memory_delete` is the only cleanup path.

**Fix**:
- Add `last_accessed_at` and `access_count` columns to the memories table
- Update on every search hit / retrieval
- Factor recency and access frequency into search scoring
- Optional: periodic garbage collection of untouched auto-extracted memories older than N days

### 2.4 No semantic deduplication of auto-extracted memories

**Location**: `src/memory/extractor.ts`, `src/agent/loop.ts:834-842`

Auto-extracted memories use the LLM-generated key prefixed with `auto/`. If the same fact is worded slightly differently across conversations, it creates separate entries (e.g., `auto/preferred_language` vs `auto/favorite_programming_language`).

**Impact**: Duplicated facts waste storage and dilute search results.

**Fix**: Before storing an auto-extracted memory, check semantic similarity against existing memories with the same category. If similarity > threshold (e.g., 0.9), update the existing entry instead of creating a new one.

### 2.5 Embedding provider hardcoded in bootstrap

**Location**: `src/bootstrap.ts:87`

`createMemory()` always creates a `Qwen3VLEmbeddings` instance. `LlamaCppEmbeddings` and `OpenAIEmbeddings` implementations exist but aren't selectable through config.

**Impact**: Users with different embedding setups (standard llama.cpp, OpenAI fallback) can't use them without code changes.

**Fix**: Add an `embeddings.provider` config field (default `"qwen3-vl"`) and wire the factory:
```
qwen3-vl → Qwen3VLEmbeddings
llamacpp → LlamaCppEmbeddings
openai → OpenAIEmbeddings
```

### 2.6 No memory garbage collection

Auto-extracted memories (`auto/*`), compaction-extracted memories (`compaction/*`), and log-indexed chunks (`log:*`) accumulate indefinitely. There's no pruning mechanism.

**Impact**: Memory store grows linearly with usage. Search performance degrades (see 2.1). Storage impact is modest (SQLite handles it), but relevance dilution is real.

**Fix**: Periodic GC that:
- Deletes `auto/*` memories not accessed in N days (requires access tracking from 2.3)
- Caps `log:*` entries to the last M days
- Reports memory stats (count by category/source) via a `memory_stats` tool

### 2.7 Compaction flush and auto-extraction can race

**Location**: `src/agent/loop.ts:655-683` (triggerCompaction), `src/agent/loop.ts:456-458` (auto-extract)

Both `triggerCompaction` → `flushDroppedToMemory` and `runAutoExtraction` fire async after a turn. Both call `memory.set()` on the same store. If they extract overlapping facts with the same key, last-write-wins.

**Impact**: Low severity — key collision is unlikely since compaction uses `compaction/` prefix and extraction uses `auto/`. But if the local LLM generates identical keys in both paths, one extraction silently overwrites the other.

**Fix**: Acceptable as-is given key prefixing. Document the intentional key namespace separation.

---

## 3. Routing

### 3.1 Task type detection is fragile keyword matching

**Location**: `src/routing/model-router.ts:202-237`

`detectTaskType()` uses `string.includes()` on hardcoded keywords. "Why did the chicken cross the road?" → `reasoning` (because "why"). "Can you explain this joke?" → `reasoning`. These would potentially route to a remote model unnecessarily.

**Impact**: Over-routes to remote for conversational messages that contain reasoning keywords. Under-routes for actual reasoning tasks that don't use the magic words.

**Fix**: Two approaches:
- **Quick**: Require multiple signals (keyword + length + complexity estimate) before classifying as reasoning/code_generation
- **Better**: Use the local LLM itself to classify the task type (adds latency but much more accurate). This could be a fast single-token classification call.

### 3.2 Escalation patterns are too aggressive

**Location**: `src/routing/escalation.ts:10-21`

`UNCERTAINTY_PATTERNS` includes phrases that are normal model behavior, not signals of struggle:
- `"let me think"` — model being deliberate
- `"this is complex"` — accurate assessment, not failure
- `"this requires"` — often followed by a correct tool call

**Impact**: False-positive escalations, wasting API calls on tasks the local model was handling fine.

**Fix**: Make these patterns contextual — only trigger escalation when combined with other signals (short response, no tool calls, low confidence). Consider removing "let me think" and "this is complex" entirely.

### 3.3 No routing feedback loop

The router doesn't learn from outcomes. If local consistently succeeds at tasks it would route to remote, the routing rules don't adapt.

**Impact**: Suboptimal cost/performance trade-off over time.

**Fix**: Track routing outcomes (local success rate by task type, escalation frequency) in memory. Use this as additional signal in routing decisions. Even simple heuristics ("local succeeded at code_generation 90% of the time this week → lower escalation confidence") would help.

### 3.4 No cost awareness in routing

**Location**: `src/routing/model-router.ts`

`StatsTracker` exists and tracks token usage, but the router doesn't consider cost. There's no budget cap or cost-weighted routing.

**Impact**: The system will happily route everything to Claude if the heuristics say so, with no spending guardrails.

**Fix**: Add optional `daily_budget` or `monthly_budget` to routing config. Router checks StatsTracker before routing to remote. If budget is exhausted, force local with a warning.

---

## 4. Context Window Management

### 4.1 No priority-aware message dropping

**Location**: `src/agent/context-window.ts:282-295`

When context overflows, messages are dropped from the front (oldest first). No consideration of message importance. A critical decision from 5 minutes ago drops before a trivial greeting from 3 minutes ago.

**Impact**: Important context lost while trivial messages survive.

**Fix**: Weight messages by role and content:
- Tool results with errors → lower priority (less likely to be referenced)
- User messages with decisions/instructions → higher priority
- Memory recall injections → lowest priority (can be re-retrieved)
- Keep a sliding window that preserves the last N user messages regardless

### 4.2 Token estimation drift for remote providers

**Location**: `src/agent/context-window.ts:24-26`

Remote providers use the `chars / 3.5` estimation. This can be off by 20-30% for code-heavy content (code tokens are shorter than prose tokens). For a 200K context window, that's 40-60K tokens of drift.

**Impact**: Either over-fitting (sending too much, causing 400 errors) or under-fitting (dropping messages unnecessarily).

**Fix**: For Anthropic specifically, use their published tokenizer or the `token_count` from their API response to calibrate the estimation ratio over time.

---

## 5. Task Runner

### 5.1 Single-task execution (no concurrency)

**Location**: `src/tasks/runner.ts:186, 319`

`isExecuting` flag serializes all task execution. One task at a time. If a long-running task blocks the tick loop, queued events wait.

**Impact**: Event-driven tasks (file watch, webhooks) can miss their window. Scheduled tasks pile up.

**Fix**: Allow configurable concurrency (default 1, max N). Use a semaphore instead of a boolean flag. The session mutex already serializes agent runs, so concurrent tasks would queue at that level.

### 5.2 AbortController not wired to agent or tools

**Location**: `src/tasks/runner.ts:321, 689-693`

`abortController` is created per task execution but isn't passed to the `AgentLoop` or `ToolExecutor`. The timeout races against execution but doesn't actually cancel in-flight work.

**Impact**: Timed-out tasks leave orphaned LLM calls and tool executions running. The task reports timeout, but compute is wasted.

**Fix**: Pass `AbortSignal` through to `AgentLoop.run()` and check it between tool calls and before LLM calls.

### 5.3 Task conversations are ephemeral — no cross-run context

**Location**: `src/tasks/runner.ts:600` (comment: "No conversation store — task conversations are ephemeral")

Each task run starts with a fresh AgentLoop and no conversation history. Memory tools provide some continuity, but the model can't reference "what I did last run" directly.

**Impact**: Tasks that build on previous results (e.g., incremental code review, ongoing monitoring) lose conversation context between runs.

**Fix**: Optional conversation persistence per task. Add a `persist_conversation` flag to task config. When enabled, use a dedicated session ID per task and load previous messages on each run.

---

## Priority Ranking

### High Impact, Moderate Effort
1. **2.1** Brute-force vector search → in-memory cache as first step
2. **1.3** Full-conversation re-extraction → track extraction index
3. **2.2** FTS score normalization → use BM25 rank directly
4. **2.3** Memory decay + access tracking → schema migration + scoring update

### High Impact, Higher Effort
5. **2.4** Semantic deduplication of auto-extracted memories
6. **3.1** Better task type detection (multi-signal or LLM-based)
7. **1.1** Tool result truncation at ingestion
8. **3.4** Cost awareness / budget caps in routing

### Medium Impact, Low Effort
9. **3.2** Tune escalation patterns (remove false-positive triggers)
10. **1.2** Memory recall deduplication across turns
11. **2.5** Embedding provider selection in bootstrap
12. **1.5** Planning mode phase tracking

### Lower Priority
13. **1.4** Bidirectional escalation (de-escalation)
14. **1.6** Infinite tool loop detection
15. **2.6** Memory garbage collection (needs 2.3 first)
16. **4.1** Priority-aware message dropping
17. **5.1** Task runner concurrency
18. **5.2** AbortController propagation
19. **5.3** Task conversation persistence
