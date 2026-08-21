# egirl — A Local AI That Runs Its Own Loop

## What This Is

egirl is a long-running local AI agent built on one premise: **the agent is the human in the loop.** In an ordinary harness a person supplies the judgment the model lacks — when to stop, when to keep going, when the work has drifted, when to write things down, when to ask for help. Run the agent unattended and every one of those becomes a gap that has to be real code. egirl is that code: a single instance you point at a goal, leave alone for days, and that either finishes it or comes back with a specific question — on owned hardware, where compute is not the constraint. It runs indefinitely by default and stops only for reasons that genuinely warrant stopping.

It is a capable local operator that does the work itself. Around that core sits the autonomy engine — unbounded runs, consolidation-break checkpoints, mechanical failure detectors (stuck-inference abort, reasoning/repeat spiral), context recycle-from-NOTES, and `report`-to-a-supervisor at the edge of its own authority — plus long-running memory, a toolbelt shaped like a human's hands (shell, files, git, browser, web), and several ways to talk to it (CLI, Discord, XMPP, HTTP API). `code_agent` (Claude Code / Codex) is one tool among many for handing off engineering work — available, not central. See `docs/autonomy-loop.md` for the control model.

Single user. Single operator model. No cloud escalation, no routing decisions — the local LLM is the operator, and it escalates to *tools*, not to other models.

## The Mental Model

> **One local LLM is the operator. It does the work and runs its own loop. It escalates to tools, not to other models.**

If you ever catch yourself adding "what if we route this to a bigger model" logic, stop. That's not what this is. If the local model can't do something itself, it calls a tool — `execute_command` / `browser_*` / `web_research` / `git_*` for the work, `report` to reach a supervisor (human or peer agent) at the edge of its authority, and `code_agent` for a code handoff when one actually earns its keep. For a capable operator, delegation mostly costs context continuity; the lever is a stronger operator, not a delegation hop.

## Purpose

egirl is built for one person at Schneewolf Labs. It behaves like a competent colleague who:
- Remembers what you've been working on
- Can be pointed at a goal and left to run it — checkpointing to notes, surviving its own context window, and reporting back when it hits a real decision or finishes
- Can run shell commands, read/write files, interact with git and GitHub, browse the web
- Knows how to drive a configured code agent when a code handoff earns its keep
- Wakes up on a cron to check in on things
- Talks back through Discord DMs, XMPP, or the terminal

Feature priorities:
- **Build**: Anything that makes an instance run longer and more autonomously (the loop, checkpointing, context survival, supervision), that makes the long-running memory richer, or that makes local → code agent delegation better when it's warranted.
- **Skip**: Generic assistant features (weather, jokes, trivia). Multi-model routing. Multi-user anything. Hypothetical future integrations.
- **Prioritize**: Depth over breadth. One autonomy loop that holds over days beats five half-wired remote providers.

## Design Philosophy

1. **Local LLM is the operator.** No model routing, no escalation to remote LLMs. Delegate to *tools* (code_agent, execute_command, browser_*) when the local model isn't the right executor.
2. **Long-running and autonomous by design.** Runs are unbounded and self-managing: checkpoint to notes, recycle context from disk, stop on a real mechanical failure or a real decision — not a turn counter. Memory survives restarts. Cron wakes it up. Conversations persist.
3. **One user, one cluster.** No auth, no pairing, no multi-user anything.
4. **Flat and readable.** Minimal abstraction. If you can grep for it, don't wrap it.
5. **Steal good ideas.** OpenClaw's skill format: yes. Their 50-layer gateway abstraction: no.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Bun |
| Language | TypeScript (strict mode) |
| Local LLM | llama.cpp HTTP server (OpenAI-compatible API) |
| Code agent | Claude Agent SDK or interactive Codex CLI (subscription auth) |
| Database | `bun:sqlite` for memory, conversations, tasks |
| Embeddings | `Qwen/Qwen3-VL-Embedding-2B` (2048-dim), served via Python CPU-only; launched by `scripts/serve-embeddings.sh` → `embedding-server/serve-embedding.py` |
| Discord | `discord.js` |
| Browser | `playwright` |
| Config | TOML (`smol-toml`), validated with TypeBox |

## Tool Calling Format

egirl uses the native Qwen3 chat template for tool calling. See [docs/tool-format.md](docs/tool-format.md) for the full specification.

## Design Language

egirl's visual identity: deep purples, hot pinks, dark neutrals. Anime cat-girl with a crescent moon. Playful but sharp. CLI should feel like it belongs to that world.

### Brand Palette

| Role | Hex | 256-color | Usage |
|------|-----|-----------|-------|
| Purple (primary) | `#af5fd7` | 135 | Headings, user prompt, section labels |
| Hot Pink (secondary) | `#ff5faf` | 198 | Agent name (`egirl>`), emphasis, brand text |
| Orchid (accent) | `#d75fd7` | 171 | Decorators, separators, tool call arrows |
| Gray (muted) | `#767676` | 243 | Timestamps, metadata |
| Soft Green (success) | `#87d787` | 114 | `ok` status |
| Rose (error) | `#ff5f87` | 204 | `err` status |
| Gold (warning) | `#ffd75f` | 221 | Warnings |
| Light Purple (info) | `#af87ff` | 141 | Info-level logs |

Themes live in `src/ui/theme.ts`. Four built-in: `egirl` (default), `midnight`, `neon`, `mono`. Set via `theme = "..."` in `egirl.toml`.

### Principles

- **256-color ANSI.** No external color libraries. Raw `\x1b[38;5;{n}m` sequences.
- **Theme-aware, not theme-dependent.** Output readable even without color support. Never encode meaning in color alone.
- **Semantic color roles.** Import `colors()` from `src/ui/theme.ts`; use `primary`, `accent`, `error`. Don't hardcode ANSI codes in display files.

## What NOT to Build

This list is load-bearing. When you catch yourself about to add one of these, stop.

- **No model routing.** The local LLM is the only chooser. "Escalate" means "call a tool." If you find yourself writing a `Router` class, you've lost the plot.
- **No remote LLM providers** (Anthropic API, OpenAI, etc.) for per-message routing. Code agents are invoked through local CLI/SDK integrations with subscription auth; they are tools, not chat providers.
- **No internal plugin system.** Channels, providers, tools are hardcoded. CLI, Discord, and XMPP are concrete `Channel` implementations, each optional via config. No dynamic registration, no discovery, no capability negotiation. If a fourth is genuinely wanted, hardcode it too; don't build a pluggable layer. Extensibility lives at the HTTP API boundary, not inside the process.
- **External HTTP API is encouraged.** A small `Bun.serve` in `src/api.ts` lets scripts, mobile apps, automations, LAN clients, and external UIs talk to egirl without running in-process. Keep it tiny — no OpenAPI spec generation, no versioned routes, no tiered rate limits, no framework. Each endpoint should pay for itself; when in doubt delete rather than add.
- **No workflow engine.** The LLM is the workflow engine. Don't build a second one.
- **No event-driven task triggers** (file watchers, GitHub webhooks, inbound HTTP). Cron is enough. If you think you need webhooks, reconsider — almost always the right design is "check on a schedule."
- **No plugin system for providers.** One local provider. That's the whole list.
- **No skill gating/permissions.** You're the only user.
- **No multi-user anything.**

## Rules for Working in This Codebase

### Sacred Files

Workspace files are user data, not code. **Never modify without explicit permission**:
- `SOUL.md` — Personality definition
- `MEMORY.md` — Long-term curated facts
- `USER.md` — User profile
- `IDENTITY.md` — Name, emoji, identity config
- `AGENTS.md` — Operating instructions

These belong to the user. Treat like personal notes.

### Don't Be Helpful

No unsolicited changes. No "while I was in here I also..." modifications. No README additions not requested. No barrel file creation to "clean up" imports. No refactoring adjacent code. No comments, docstrings, or type annotations on code you didn't change. No "improving" error handling in unrelated functions. Do exactly what was asked. Stop.

### When Uncertain

- **Ask** for architectural decisions, new dependencies, changes affecting multiple files.
- **Make a call** for implementation details, variable names, local structure.
- A 30-second clarification beats a 30-minute redo.

### Dependencies

Don't install new packages without asking. The current stack is intentionally minimal:

```
@anthropic-ai/claude-agent-sdk   # Claude Code backend
node-pty                         # interactive Codex backend
@sinclair/typebox                # config validation
discord.js                       # one remote interface
playwright                       # browser tool
smol-toml                        # config parsing
yaml                             # skill frontmatter
```

If you think you need a new dep, explain what for, list alternatives, wait.

### Git Conventions

Commit messages: imperative, concise, no trailing period.
```
Add memory search tool
Fix heartbeat schedule parsing
Remove unused tracking code
```

Branches: `feature/thing`, `fix/thing`, `refactor/thing`. Batch related changes into single commits.

## Code Style

### TypeScript

- Prefer `interface` for object shapes.
- Use TypeBox for runtime validation, infer static types from schemas.
- No `any` — use `unknown` and narrow.
- Explicit return types on exported functions.
- Barrel exports only at module boundaries, not within modules.

### Null vs Undefined

- Prefer `undefined` in application code.
- `null` is acceptable at external boundaries (SQLite, SDK responses).

### Error Handling

- Throw early, catch at boundaries (agent loop, channel handlers).
- Discriminated unions for expected failure states, not exceptions.
- Never swallow errors silently — log at minimum.
- Tool execution errors return `{ success: false, output: "..." }`, they don't throw.

### Patterns to Follow

- One file = one concept. **Target 200 lines per file.** The current `agent/loop.ts` violates this and needs to be split — don't make it worse.
- Functions over classes unless you need stateful instances.
- Explicit dependencies via parameters, not module-level singletons.
- Config loaded once at startup, passed down.
- Early returns to reduce nesting.

### Patterns to Avoid

- No DI frameworks, no decorators, no inheritance hierarchies.
- No default exports (named exports are greppable).
- No complex generics unless truly necessary.

### Naming

- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE` only for true constants (not config values).
- Booleans: prefix with `is`, `has`, `should`, `can`.

### Testing

- Tests live in `test/`, mirroring `src/` structure.
- Use `bun:test`. No Jest, no Vitest.
- Test behavior, not implementation.
- Mock at module boundaries (providers, filesystem), not internal functions.

### Verification

After changes, run all three before considering work complete:

```
bun test          # unit tests
bun run lint      # biome
bun run typecheck # tsc --noEmit
```

All three must pass. Don't push code that fails any of these.
