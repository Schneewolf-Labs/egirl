# Codebase Refactoring Analysis

Audit of the egirl codebase against the conventions in CLAUDE.md, identifying maintainability issues and concrete refactoring suggestions.

Items marked with **[DONE]** have been completed.

---

## 1. ~~Broken Imports (Runtime Failures)~~ **[DONE]**

Three files referenced `../utils/logger` instead of `../util/logger`. All three have been fixed. The dead `src/tools/loader.ts` file was removed entirely.

---

## 2. ~~`src/index.ts` Does Too Much~~ **[DONE]**

The entry point has been reduced from 581 lines to ~120 lines. A shared bootstrap function was extracted to `src/bootstrap.ts`, and each command runner was moved to its own file under `src/commands/`:

```
src/
  bootstrap.ts              # createAppServices() → shared context
  commands/
    cli.ts                  # runCLI()
    discord.ts              # runDiscord()
    xmpp.ts                 # runXMPP()
    claude-code.ts          # runClaudeCode()
    api.ts                  # runAPI()
    status.ts               # showStatus()
  index.ts                  # ~120 lines: parse args, switch on command, call runner
```

---

## 3. ~~`src/providers/llamacpp.ts` — Two Unrelated Classes~~ **[DONE]**

`LlamaCppTokenizer` has been extracted to `src/providers/llamacpp-tokenizer.ts`. The provider file (`llamacpp.ts`) is now ~372 lines — still above the 200-line guideline but the stream-reading logic is inherently complex and cohesive.

---

## 4. ~~`src/memory/embeddings.ts` — Three Providers in One File~~ **[DONE]**

Embedding providers have been split into separate files:

```
src/memory/embeddings/
  types.ts                  # EmbeddingInput, EmbeddingProvider interface, config types
  qwen3-vl.ts              # Qwen3VLEmbeddings
  llamacpp.ts              # LlamaCppEmbeddings
  openai.ts                # OpenAIEmbeddings
  index.ts                 # createEmbeddingProvider factory + re-exports
```

---

## 5. `src/channels/discord.ts` — Mixed Concerns (481 lines)

Formatting and event handler helpers have been partially extracted to `src/channels/discord/formatting.ts` and `src/channels/discord/events.ts`. The main `discord.ts` file is still 481 lines. The message splitting logic and some formatting functions could still be extracted further.

---

## 6. Tool Parameter Typing

All tool `execute` methods use `Record<string, unknown>` and cast parameters inline:

```typescript
async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const dir = resolveCwd(params.repo_dir as string | undefined, cwd)
  const staged = params.staged as boolean | undefined
  const files = params.files as string[] | undefined
```

This pattern is repeated across every tool (~12 instances). It provides no runtime validation and loses type safety.

### Suggested refactor

Use TypeBox schemas (already a dependency) to define tool parameters and validate at the executor boundary:

```typescript
// In each tool file
const GitDiffParams = Type.Object({
  staged: Type.Optional(Type.Boolean()),
  files: Type.Optional(Type.Array(Type.String())),
  ref: Type.Optional(Type.String()),
  repo_dir: Type.Optional(Type.String()),
})
type GitDiffParams = Static<typeof GitDiffParams>

// Tool interface becomes:
interface Tool<P = Record<string, unknown>> {
  definition: ToolDefinition
  paramSchema?: TSchema            // optional TypeBox schema
  execute(params: P, cwd: string): Promise<ToolResult>
}
```

The `ToolExecutor` validates parameters against the schema before calling `execute`, catching malformed LLM output before it causes confusing downstream errors.

---

## 7. ~~Duplicated Arg Parsing Pattern~~ **[DONE]**

Shared log-level-from-args logic has been extracted to `applyLogLevel()` in `src/util/args.ts`.

---

## 8. ~~Dead / Stub Code~~ **[DONE]**

- `src/tools/loader.ts` — Removed entirely. The dead `ToolLoader` stub no longer exists.
- `src/skills/index.ts` — `SkillManager` class has been removed. Only the parsing/loading exports remain.

---

## 9. Unused Dependency: `yaml`

The `yaml` package is only imported in `src/skills/parser.ts` to parse YAML frontmatter in skill markdown files. Skills are loaded at startup via `loadSkillsFromDirectories()` — the dependency is used at runtime, so this is no longer a concern.

---

## 10. Missing Test Coverage

### Modules with no tests:
| Module | Risk |
|--------|------|
| `src/channels/discord.ts` | High — complex message handling, session management, queue logic |
| `src/channels/claude-code.ts` | High — external process integration |
| `src/channels/cli.ts` | Low — thin wrapper |
| `src/channels/xmpp.ts` | Medium — event handling |
| `src/api/routes.ts` | Medium — HTTP endpoint logic |
| `src/api/server.ts` | Low — thin Bun.serve wrapper |
| `src/memory/indexer.ts` | Medium — SQLite operations |
| `src/memory/embeddings/` | Medium — HTTP calls to external services |
| `src/conversation/store.ts` | Medium — SQLite persistence |
| `src/agent/loop.ts` | High — core agent logic, escalation, tool execution (958 lines) |

### Tests that would add the most value:
1. **Agent loop** — mock providers and tool executor, test escalation flow, max-turns recovery, conversation persistence
2. **Discord channel** — test message filtering (allowed users/channels), session key resolution, message queue draining
3. **Conversation store** — test CRUD, compaction, message ordering

---

## 11. Files Over 200 Lines (Convention Violations)

Updated line counts after refactoring:

| File | Lines | Status |
|------|-------|--------|
| `src/agent/loop.ts` | 958 | Largest file — could extract retry logic, tool dispatch |
| `src/channels/discord.ts` | 481 | Partially extracted — formatting/events split out, main file still large |
| `src/channels/claude-code.ts` | ~430 | Protocol handling is inherently complex |
| `src/providers/llamacpp.ts` | 372 | Tokenizer extracted, stream logic is cohesive |
| `src/api/openapi.ts` | ~388 | Declarative spec, splitting would hurt readability |
| `src/tools/builtin/git.ts` | ~359 | Independent tools sharing helpers; could split per-tool |
| `src/tools/builtin/memory.ts` | ~446 | Grew with `memory_recall` addition |
| `src/agent/context-window.ts` | ~315 | Cohesive algorithm with clear sections |
| `src/memory/indexer.ts` | ~266 | SQLite + vector ops are intertwined |
| `src/memory/index.ts` | ~246 | Borderline |
| `src/api/routes.ts` | ~237 | Borderline — could split into route groups |
| `src/config/index.ts` | ~205 | Just over limit, cohesive |
| `src/index.ts` | 120 | **[DONE]** — extracted to bootstrap + commands |
| `src/memory/embeddings.ts` | — | **[DONE]** — split into `embeddings/` directory |

---

## 12. Minor Issues

### Inconsistent error logging in skills parser
`src/skills/parser.ts:30` uses `console.warn()` instead of `log.warn()` (the project's logger):
```typescript
console.warn('Failed to parse skill frontmatter:', error)
```

### `AgentLoop` constructor takes 8 positional parameters
```typescript
constructor(
  config, router, toolExecutor, localProvider, remoteProvider,
  sessionId, memory, conversationStore
)
```

An options object would be more readable and extensible:
```typescript
interface AgentLoopDeps {
  config: RuntimeConfig
  router: Router
  toolExecutor: ToolExecutor
  localProvider: LLMProvider
  remoteProvider: LLMProvider | null
  sessionId: string
  memory?: MemoryManager
  conversationStore?: ConversationStore
}
```

---

## Priority Summary

| Priority | Item | Status |
|----------|------|--------|
| ~~**P0**~~ | ~~Fix 3 broken imports (`utils` → `util`)~~ | **Done** |
| ~~**P1**~~ | ~~Extract command runners from `index.ts` + shared bootstrap~~ | **Done** |
| ~~**P1**~~ | ~~Extract `LlamaCppTokenizer` to its own file~~ | **Done** |
| ~~**P2**~~ | ~~Split embedding providers into separate files~~ | **Done** |
| **P2** | Extract Discord channel helpers further | Partial |
| **P2** | Add TypeBox validation to tool parameters | Open |
| **P2** | Add agent loop and Discord channel tests | Open |
| ~~**P3**~~ | ~~Remove dead `ToolLoader` stub~~ | **Done** |
| ~~**P3**~~ | ~~Wire or remove `SkillManager`~~ | **Done** |
| ~~**P3**~~ | ~~Extract shared arg parsing~~ | **Done** |
| **P3** | Refactor `AgentLoop` constructor to options object | Open |
