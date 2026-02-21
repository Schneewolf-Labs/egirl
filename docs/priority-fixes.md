# Priority Fixes — Agent Loop, Execution & Memory

Ordered implementation plan derived from [analysis-agent-loops.md](analysis-agent-loops.md). Grouped into three tiers based on impact vs effort.

---

## Tier 1 — High-Impact, Ship First

These fix real bugs or activate dead subsystems. Do these before adding new features.

### P1: Hard loop termination on repeated tool calls
**Gap**: 1.2 | **Effort**: ~30 min | **Files**: `src/agent/loop.ts`

The loop warns on repeated identical tool calls but never force-breaks. A stubborn local model burns all 10 turns calling the same tool.

**Change**:
- Track repeat count per `(name, args)` key in `seenToolCalls` (change from `Set<string>` to `Map<string, number>`)
- After 3 identical calls, inject a final warning and `break` the loop
- Return the last assistant content as the response, same as the `maxTurns` exhaustion path

```
loop.ts:357-364 — change Set to Map, add counter
loop.ts:424-432 — add break condition when count >= 3
```

### P2: Schedule memory GC on startup
**Gap**: 3.2 | **Effort**: ~20 min | **Files**: `src/bootstrap.ts`, `src/memory/gc.ts`

`collectGarbage()` is tested and correct but never called. Auto-extracted memories with zero accesses accumulate forever, diluting search quality.

**Change**:
- Call `collectGarbage(indexer)` in `createAppServices()` after memory manager init (fire-and-forget, non-blocking)
- Add a `[memory.gc]` config section with `enabled`, `autoMaxAgeDays`, `conversationMaxAgeDays`
- Log results at info level

```
bootstrap.ts — add GC call after memory init (~line 116)
config/schema.ts — add gc config
```

### P3: Fix auto-extraction key collisions
**Gap**: 3.4 | **Effort**: ~15 min | **Files**: `src/agent/loop.ts`

Auto-extracted keys like `auto/preferred_language` collide across sessions, silently overwriting via `ON CONFLICT(key)`.

**Change**:
- Prefix auto-extracted keys with a short session hash: `auto/{sessionId.slice(0,8)}/{key}`
- Same for compaction keys: `compaction/{sessionId.slice(0,8)}/{key}`

```
loop.ts:914 — change key format
loop.ts:772 — change key format
```

### P4: Fix retrieval char/token budget mismatch
**Gap**: 3.5 | **Effort**: ~15 min | **Files**: `src/memory/retrieval.ts`

`maxTokensBudget` compares characters, making the effective budget ~3.5x smaller than configured. The agent retrieves fewer memories than it should.

**Change**:
- Rename to `maxCharsBudget` in the config and code (honest naming)
- Or multiply by 3.5 when comparing: `if (charCount + line.length > maxTokensBudget * 3.5) break`
- Update `config/schema.ts` default if renaming

```
retrieval.ts:65 — fix comparison
config/schema.ts — rename or adjust default
```

### P5: Executor-level tool timeout
**Gap**: 2.3 | **Effort**: ~30 min | **Files**: `src/tools/executor.ts`

Most built-in tools have internal timeouts, but the executor has no hard ceiling. A misbehaving tool blocks the entire agent.

**Change**:
- Wrap `tool.execute(args, cwd)` in `Promise.race` with a 120s timer
- Make timeout configurable via `[tools]` config
- Return a failure result on timeout (not throw)

```
executor.ts:137-155 — add Promise.race wrapper
config/schema.ts — add tools.executionTimeoutMs
```

---

## Tier 2 — Medium-Impact, Important for Reliability

These prevent data loss and improve throughput. Do after Tier 1.

### P6: Guard compaction against concurrent runs
**Gap**: 1.1 + 4.1 | **Effort**: ~1 hour | **Files**: `src/agent/loop.ts`

Fire-and-forget compaction can race with the next turn. The same dropped messages get summarized twice, and `this.context.conversationSummary` is written without synchronization.

**Change**:
- Add a `private compactionPromise: Promise<void> | null` field
- In `triggerCompaction()`, if a compaction is already running, skip (don't queue a second)
- In `chatWithContextWindow()`, `await this.compactionPromise` before reading `conversationSummary` for fitting
- This doesn't require extending the mutex — just local state coordination

```
loop.ts:722-750 — track promise, skip if in-flight
loop.ts:648 — await previous compaction before fitting
```

### P7: Incremental conversation persistence
**Gap**: 3.3 | **Effort**: ~45 min | **Files**: `src/agent/loop.ts`

A crash mid-loop loses all intermediate messages. User has to re-explain.

**Change**:
- Persist the user message immediately at the start of `doRun()` (after line 194)
- Persist each tool call + tool result pair after execution (inside the tool result loop at line 382)
- Bump `persistedIndex` after each write
- This adds SQLite writes but they're fast with WAL mode (sub-ms)

```
loop.ts:194 — persist user message immediately
loop.ts:396-400 — persist tool messages after execution
```

### P8: Parallel tool execution with hooks
**Gap**: 2.1 | **Effort**: ~45 min | **Files**: `src/agent/loop.ts`

Tools always run sequentially when event handlers or transcript logging are present (which is almost always). Multi-tool turns take 2x+ longer than necessary.

**Change**:
- Execute all tools in parallel via `Promise.all`
- Collect results into a map
- Emit events in call order after all tools complete
- Transcript entries get sequential timestamps (order preserved)
- Keep `onBeforeToolExec` skip logic — run all non-skipped tools in parallel

```
loop.ts:838-882 — restructure executeToolsWithHooks
```

---

## Tier 3 — Lower Priority, Nice to Have

These improve quality or future-proof but aren't blocking real work today.

### P9: Wire working memory into agent loop
**Gap**: 3.1 | **Effort**: ~2 hours | **Files**: multiple

A full subsystem exists but is dead code. Wiring it in requires:
1. Add `workingMemory?: WorkingMemory` to `AgentLoopDeps`
2. Call `workingMemory.buildContext()` in `doRun()` and inject as a message (like proactive recall)
3. Create `working_memory_set` / `working_memory_get` / `working_memory_promote` tools
4. Register in `createDefaultToolExecutor()`
5. Run `getPromotionCandidates()` in the extraction cycle and promote to long-term

This is medium effort because it touches tools, config, bootstrap, and the agent loop. Should be a standalone PR.

### P10: Embedding cache eviction
**Gap**: 3.6 | **Effort**: ~1 hour | **Files**: `src/memory/indexer.ts`

All embeddings cached in RAM forever. At ~8KB per entry, this becomes a problem at scale.

**Change**:
- Add a configurable cache size limit (default 5000 entries)
- On `getAllWithEmbeddings()`, if cache exceeds limit, evict entries with lowest `accessCount`
- Or switch to lazy loading: only cache embeddings accessed in the current session

### P11: Stale escalation re-analysis
**Gap**: 1.4 | **Effort**: ~15 min | **Files**: `src/agent/loop.ts`

When a tool suggests escalation, the code re-analyzes the LLM response instead of using the tool's reason.

**Change**:
- At line 402-416, construct `EscalationDecision` directly from `result.escalation_reason` and a fixed confidence (0.7) instead of calling `analyzeResponseForEscalation()`

### P12: Cross-session conversation search
**Gap**: 3.8 | **Effort**: ~3 hours | **Files**: `src/conversation/store.ts`

Add FTS5 to the messages table so the agent can search past conversations. High effort but high value for the "what did we discuss last week?" use case.

---

## Implementation Order

```
Week 1 (quick wins):
  P1  Hard loop termination        ~30 min
  P2  Schedule memory GC           ~20 min
  P3  Fix key collisions           ~15 min
  P4  Fix retrieval budget         ~15 min
  P5  Executor timeout             ~30 min

Week 2 (reliability):
  P6  Guard compaction races       ~1 hour
  P7  Incremental persistence      ~45 min
  P8  Parallel tool execution      ~45 min

Later (depth):
  P9  Wire working memory          ~2 hours
  P10 Embedding cache eviction     ~1 hour
  P11 Stale escalation fix         ~15 min
  P12 Cross-session search         ~3 hours
```

### What NOT to fix (by design)

- **Double-pass truncation (2.2)**: Defensive, doesn't cause bugs, not worth the churn.
- **Energy pre-flight check (2.4)**: Autonomous mode is opt-in and niche.
- **Planning mode tool budget (1.5)**: Works fine with hardcoded 20 turns.
- **No token budget tracking (1.3)**: `fitToContextWindow` handles this well enough.
- **Memory versioning (3.7)**: Single-user context makes recovery less critical.
- **Discord session eviction (4.2)**: Single-user with bounded channels.
