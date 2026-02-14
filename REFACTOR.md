# Codebase Refactoring Analysis

Audit of the egirl codebase against the conventions in CLAUDE.md, identifying maintainability issues and concrete refactoring suggestions.

---

## 1. Broken Imports (Runtime Failures)

Three files reference `../utils/logger` instead of `../util/logger`:

| File | Line | Broken Import |
|------|------|---------------|
| `src/tools/loader.ts` | 2 | `../utils/logger` |
| `src/skills/index.ts` | 7 | `../utils/logger` |
| `src/skills/loader.ts` | 5 | `../utils/logger` |

**Impact**: These modules will throw `MODULE_NOT_FOUND` at runtime.
**Fix**: Replace `../utils/logger` with `../util/logger` in all three files. One-line fix each.

---

## 2. `src/index.ts` Does Too Much (581 lines)

The main entry point contains 6 independent command runners (`runCLI`, `runDiscord`, `runXMPP`, `runClaudeCode`, `runAPI`, `showStatus`) plus shared setup helpers. This violates the ~200 line convention and mixes unrelated concerns.

Each runner follows the same pattern: parse args, create providers, create memory, create router, create agent, create channel, wire shutdown. This boilerplate is duplicated 4 times.

### Suggested refactor

**Extract a shared bootstrap function** to eliminate duplication:

```
src/
  bootstrap.ts              # createAppContext() → { providers, memory, router, toolExecutor, conversations }
  commands/
    cli.ts                  # runCLI()
    discord.ts              # runDiscord()
    xmpp.ts                 # runXMPP()
    claude-code.ts          # runClaudeCode()
    api.ts                  # runAPI()
    status.ts               # showStatus()
  index.ts                  # ~50 lines: parse args, switch on command, call runner
```

The bootstrap function centralizes the repeated pattern:

```typescript
interface AppContext {
  config: RuntimeConfig
  providers: ProviderRegistry
  memory: MemoryManager | undefined
  conversations: ConversationStore | undefined
  router: Router
  toolExecutor: ToolExecutor
}

function createAppContext(config: RuntimeConfig): AppContext { ... }
```

Each command file becomes a focused ~60-80 line module that receives the shared context and wires up its channel-specific logic.

**Lines saved**: ~300 (duplicated provider/memory/router setup across 4 runners).

---

## 3. `src/providers/llamacpp.ts` — Two Unrelated Classes (422 lines)

This file contains both `LlamaCppProvider` (the chat completion provider) and `LlamaCppTokenizer` (a caching tokenizer). These are independent concerns that happen to share an endpoint.

### Suggested refactor

```
src/providers/
  llamacpp.ts               # LlamaCppProvider only (~340 lines)
  llamacpp-tokenizer.ts     # LlamaCppTokenizer + factory (~65 lines)
```

The provider is still borderline at ~340 lines, but the stream-reading logic is inherently complex and cohesive. The `formatMessagesForQwen3` function (lines 363-418) could also be extracted to a dedicated `src/providers/qwen3-format.ts` if desired, bringing the provider under 300 lines.

---

## 4. `src/memory/embeddings.ts` — Three Providers in One File (308 lines)

Contains `Qwen3VLEmbeddings`, `LlamaCppEmbeddings`, and `OpenAIEmbeddings` plus a factory function. Each class is independent.

### Suggested refactor

```
src/memory/embeddings/
  types.ts                  # EmbeddingInput, EmbeddingProvider interface, config types
  qwen3-vl.ts              # Qwen3VLEmbeddings (~50 lines)
  llamacpp.ts              # LlamaCppEmbeddings (~120 lines)
  openai.ts                # OpenAIEmbeddings (~70 lines)
  index.ts                 # createEmbeddingProvider factory + re-exports
```

Each provider file becomes self-contained and independently testable.

---

## 5. `src/channels/discord.ts` — Mixed Concerns (442 lines)

The Discord channel mixes client lifecycle, message handling, event state tracking, message formatting, and message splitting. The helper functions at the top (formatting, event handler factory) are logically separate from the channel class.

### Suggested refactor

```
src/channels/discord/
  channel.ts               # DiscordChannel class (~250 lines)
  formatting.ts            # formatToolCallsMarkdown, buildToolCallPrefix, truncateResult (~50 lines)
  events.ts                # createDiscordEventHandler, DiscordEventState (~40 lines)
  message-split.ts         # splitMessage logic (~30 lines)
  index.ts                 # re-export createDiscordChannel
```

This keeps each file focused and makes the formatting/splitting logic independently testable.

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

## 7. Duplicated Arg Parsing Pattern

Every command runner duplicates the same log-level-from-args logic:

```typescript
if (args.includes('--quiet') || args.includes('-q')) {
  log.setLevel('error')
} else if (args.includes('--verbose') || args.includes('-v') || args.includes('--debug') || args.includes('-d')) {
  log.setLevel('debug')
}
```

This appears in `runCLI`, `runDiscord`, `runXMPP`, `runClaudeCode`, and `runAPI` (5 copies).

### Suggested refactor

Extract to `src/util/args.ts`:

```typescript
export function applyLogLevel(args: string[]): void {
  if (args.includes('--quiet') || args.includes('-q')) {
    log.setLevel('error')
  } else if (args.includes('--verbose') || args.includes('-v') || args.includes('--debug') || args.includes('-d')) {
    log.setLevel('debug')
  }
}
```

---

## 8. Dead / Stub Code

### `src/tools/loader.ts`
The `ToolLoader` interface and `createToolLoader()` factory are placeholders that return empty arrays. No code calls them. Remove the file entirely until dynamic tool loading is actually implemented.

### `src/skills/index.ts` — `SkillManager` class
The `SkillManager` class is defined and exported but never instantiated in the application. The `main()` function doesn't use skills at all. If skills aren't wired into the agent loop yet, this is dead code.

**Recommendation**: Either wire `SkillManager` into the agent bootstrap or remove the class and keep only the parsing/loading exports that tests exercise.

---

## 9. Unused Dependency: `yaml`

The `yaml` package is only imported in `src/skills/parser.ts` to parse YAML frontmatter in skill markdown files. Since the skill system itself isn't wired into the application (see item 8), this dependency is effectively unused at runtime.

If skills are planned for near-term implementation, keep it. Otherwise, remove from `package.json`.

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
| `src/memory/embeddings.ts` | Medium — HTTP calls to external services |
| `src/conversation/store.ts` | Medium — SQLite persistence |
| `src/agent/loop.ts` | High — core agent logic, escalation, tool execution |

### Tests that would add the most value:
1. **Agent loop** — mock providers and tool executor, test escalation flow, max-turns recovery, conversation persistence
2. **Discord channel** — test message filtering (allowed users/channels), session key resolution, message queue draining
3. **Conversation store** — test CRUD, compaction, message ordering

---

## 11. Files Over 200 Lines (Convention Violations)

14 files exceed the ~200 line guideline from CLAUDE.md:

| File | Lines | Actionable? |
|------|-------|-------------|
| `src/index.ts` | 581 | Yes — extract commands (item 2) |
| `src/channels/discord.ts` | 442 | Yes — extract helpers (item 5) |
| `src/agent/loop.ts` | 441 | Borderline — class is cohesive, but could extract retry logic |
| `src/channels/claude-code.ts` | 431 | Borderline — protocol handling is inherently complex |
| `src/providers/llamacpp.ts` | 422 | Yes — extract tokenizer + formatter (item 3) |
| `src/api/openapi.ts` | 388 | No — declarative spec, splitting would hurt readability |
| `src/tools/builtin/git.ts` | 359 | No — 4 independent tools, but they share helpers; could split into per-tool files |
| `src/tools/builtin/memory.ts` | 321 | Same as git.ts |
| `src/agent/context-window.ts` | 315 | No — cohesive algorithm with clear sections |
| `src/memory/embeddings.ts` | 308 | Yes — extract per-provider files (item 4) |
| `src/memory/indexer.ts` | 266 | Borderline — SQLite + vector ops are intertwined |
| `src/memory/index.ts` | 246 | Borderline |
| `src/api/routes.ts` | 237 | Borderline — could split into route groups |
| `src/config/index.ts` | 205 | No — just over limit, cohesive |

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

| Priority | Item | Effort |
|----------|------|--------|
| **P0** | Fix 3 broken imports (`utils` → `util`) | 5 min |
| **P1** | Extract command runners from `index.ts` + shared bootstrap | Small |
| **P1** | Extract `LlamaCppTokenizer` to its own file | Small |
| **P2** | Split embedding providers into separate files | Small |
| **P2** | Extract Discord channel helpers | Small |
| **P2** | Add TypeBox validation to tool parameters | Medium |
| **P2** | Add agent loop and Discord channel tests | Medium |
| **P3** | Remove dead `ToolLoader` stub | Small |
| **P3** | Wire or remove `SkillManager` | Small |
| **P3** | Extract shared arg parsing | Small |
| **P3** | Refactor `AgentLoop` constructor to options object | Small |
