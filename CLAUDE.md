# egirl — the Human in Your Agent's Loop

## What This Is

A code agent needs a person around it: someone to set intent, grant or refuse authority, notice drift, check the work, remember context, and know when to escalate. egirl is that person. It is a long-running agent on a local model that supervises Claude Code or Codex, works autonomously toward goals, delegates to other agents, and keeps its own principal informed — a person, or another agent.

Around that core sits memory, a toolbelt shaped like a human's hands (shell, files, git, browser, web), peers it can hand work to, and several ways to talk to it (CLI, chat channels, HTTP API).

## The Mental Model

> **One local LLM is the operator. It escalates to tools, not to other models. The most important tool is `code_agent`.**

If you ever catch yourself adding "what if we route this to a bigger model" logic, stop. That's not what this is. If the local model can't do something itself, it calls `code_agent` for code work, `peer_message` for another agent, `report` for its principal, or `execute_command` / `browser_*` / `web_research` / `git_*` for everything else.

## What a Human in the Loop Does

This table is the feature filter. **Build what makes one of these judgments better. Skip what doesn't.**

| Duty | Direction | Where it lives today |
|---|---|---|
| **Intent** — decide what to do and write the prompt | down, to executors | agent loop → `code_agent` |
| **Authority** — approve, deny, answer the agent's questions | down | `src/permissions/supervisor.ts` |
| **Steering** — notice drift, spirals, stalls | down | `spiral-guard`, `repetition-guard`, `nudges` |
| **Verification** — check the real artifact, not the claim | down | the rule below; little code yet |
| **Delegation** — hand work to another agent | sideways, to peers | `peer_message`, Wald discovery (`src/peers/`) |
| **Autonomy** — pursue a goal unattended for days | self | autonomy loop, tasks, cron (`docs/autonomy-loop.md`) |
| **Continuity** — remember across sessions and restarts | self | memory, `NOTES.md`, handoff, compaction |
| **Informing** — tell the principal what happened | up, to the principal | `report` notify, standup, push |
| **Suggesting** — propose what should happen next | up | not built yet |
| **Escalation** — stop and ask when a decision isn't its own | up | `report` ask, awaiting-input tasks |

See [docs/human-in-the-loop.md](docs/human-in-the-loop.md) for how these fit together and what is still missing.

Skip: generic assistant features (weather, jokes, trivia), multi-model routing, multi-tenancy, hypothetical future integrations. Prioritize depth over breadth: one delegation flow that works well beats five half-wired remote providers.

## Design Philosophy

1. **The operator is local; executors are tools.** One local model decides. It escalates to tools (`code_agent`, shell, browser, peers), never to other models.
2. **One principal per instance.** An instance answers to one principal and holds one identity and one memory. A principal can be a person or another agent. More principals means more instances talking as peers, not a multi-tenant instance.
3. **A human is a slow peer.** Reporting up to a person and to a supervising agent share one contract (`report`); only the latency differs. Supervision stacks as deep as the work warrants, with a person at the top.
4. **Authority is bounded and legible.** Every stop is mechanical (the system handles it) or semantic (it goes up to the principal). No arbitrary caps.
5. **Verify the artifact, not the claim.** An agent's report is a lead; the authoritative artifact, and the agent's own record naming it, is the evidence.
6. **Long-running by design.** Memory, notes and schedules survive restarts; judgment has to survive the context window.
7. **Flat and readable.** Minimal abstraction. If you can grep for it, don't wrap it.
8. **Steal good ideas.** OpenClaw's skill format: yes. Their 50-layer gateway abstraction: no.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Bun |
| Language | TypeScript (strict mode) |
| Local LLM | llama.cpp HTTP server (OpenAI-compatible API) |
| Code agent | Claude Agent SDK or Codex app-server (subscription auth) |
| Database | `bun:sqlite` for memory, conversations, tasks |
| Embeddings | Qwen3-VL-Embedding served via Python (see `services/embeddings/`) |
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
- **No internal plugin system.** Channels, providers, tools are hardcoded. CLI, Discord, XMPP, Telegram and Matrix are concrete `Channel` implementations, each optional via config. No dynamic registration, no discovery, no capability negotiation. If another is genuinely wanted, hardcode it too and add it to the list in `serve.ts`; don't build a pluggable layer. Shared *plumbing* is fine and expected — `src/channels/spine.ts` runs the same turn (broker, typing, narration, chunking, error reply) for every chat transport — but a shared *registry* is not. Extensibility lives at the HTTP API boundary, not inside the process.
- **External HTTP API is encouraged.** A small `Bun.serve` in `src/api.ts` lets scripts, mobile apps, automations, LAN clients, and external UIs talk to egirl without running in-process. Keep it tiny — no OpenAPI spec generation, no versioned routes, no tiered rate limits, no framework. Each endpoint should pay for itself; when in doubt delete rather than add.
- **No workflow engine.** The LLM is the workflow engine. Don't build a second one.
- **No event-driven task triggers** (file watchers, GitHub webhooks, inbound HTTP). Cron is enough. If you think you need webhooks, reconsider — almost always the right design is "check on a schedule."
- **No plugin system for providers.** One local provider. That's the whole list.
- **No permission system beyond the principal hierarchy.** Skills check `owner` / `allowed` / `everyone`; nothing finer-grained.
- **No multi-tenancy.** One principal per instance. Another principal gets another instance.

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
codex app-server (installed CLI)  # structured Codex backend
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

### Judging an agent's work: verify the authoritative artifact, not a plausibly-named one

When quantifying what a running agent (Zero, etc.) has actually accomplished, do NOT diff the
first file whose name matches the task. An agent iterates: `winter_py.bin` was a dead early
attempt left on disk, while the working solution lived in `faithful2.py` / `loco_decompress.c` /
a `cbatch` result — and diffing the stale one reported "stuck at byte 3" when the decompressor
was in fact solved and verified byte-exact across all 1372 blobs. The stale file cost two wrong
"she's stuck" reports and a pointless model swap.

Before trusting a progress metric: check the file's mtime against the agent's recent activity,
and read what its own NOTES/checkpoints name as the current artifact — the agent records which
file is the real one. The agent's own success record (a batch log, a checkpoint summary) is more
authoritative than any single artifact you pick by name.
