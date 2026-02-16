# egirl — Local-First AI Agent

## Project Overview

egirl is a personal AI agent designed for users with local GPU inference capability. It communicates via Discord and terminal, runs most tasks locally using llama.cpp, and escalates to Claude/GPT only when necessary.

This is a single-user tool, not a general-purpose framework. No auth, no multi-user, no deployment patterns.

## Purpose

egirl is built to be a productive employee for Schneewolf Labs — not a generic personal assistant. Feature development should prioritize workflows that help get real work done: code review, research, file management, task automation, and technical problem-solving.

This is not OpenClaw. OpenClaw is a general-purpose agent framework. egirl is a purpose-built tool for a specific team's needs. When deciding what to build:

- **Build**: Features that make the agent more useful for software development, research, and lab operations
- **Skip**: Generic assistant features (weather, jokes, small talk, general knowledge Q&A)
- **Prioritize**: Deep integration with the tools and workflows Schneewolf Labs actually uses
- **Avoid**: Breadth for its own sake — depth in relevant areas beats shallow coverage

The agent should behave like a competent colleague who knows the codebase, remembers context, and can be trusted with real tasks.

## Design Philosophy

1. **One user, one cluster** — No auth, no pairing, no multi-user anything
2. **Local by default** — Routing, memory, simple conversations run on your hardware at zero API cost
3. **Escalate, don't apologize** — Hand off to Claude seamlessly when local can't cut it
4. **Flat and readable** — Minimal abstraction. If you can grep for it, don't wrap it
5. **Steal good ideas** — OpenClaw's skill format: yes. Their 50-layer gateway abstraction: no

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Bun |
| Language | TypeScript (strict mode) |
| Local LLM | llama.cpp HTTP server (OpenAI-compatible API) |
| Remote LLMs | `@anthropic-ai/sdk`, `openai` npm packages |
| Database | `bun:sqlite` for memory indexing |
| Embeddings | llama.cpp serving embedding model (e.g., nomic-embed-text) |
| Discord | `discord.js` |
| Config | TOML (`smol-toml`), validated with TypeBox |

## Tool Calling Format

egirl uses the native Qwen3 chat template for tool calling. See [docs/tool-format.md](docs/tool-format.md) for the full specification.

## Design Language

egirl's visual identity is derived from the logo: deep purples, hot pinks, and dark neutrals. An anime cat-girl with a crescent moon — playful but sharp. The CLI should feel like it belongs to that world.

### Brand Palette

Extracted from the logo. Use these as the source of truth for any UI surface — terminal, HTML docs, Discord embeds.

| Role | Hex | 256-color | Usage |
|------|-----|-----------|-------|
| Purple (primary) | `#af5fd7` | 135 | Headings, user prompt, section labels |
| Hot Pink (secondary) | `#ff5faf` | 198 | Agent name (`egirl>`), emphasis, brand text |
| Orchid (accent) | `#d75fd7` | 171 | Decorators, separators, tool call arrows |
| Gray (muted) | `#767676` | 243 | Timestamps, metadata, de-emphasized text |
| Soft Green (success) | `#87d787` | 114 | `ok` status, connected, enabled |
| Rose (error) | `#ff5f87` | 204 | `err` status, failures |
| Gold (warning) | `#ffd75f` | 221 | Warnings, thresholds |
| Light Purple (info) | `#af87ff` | 141 | Info-level logs |

### CLI Theme System

Themes live in `src/ui/theme.ts`. Four built-in themes:

- **egirl** (default) — Purple/pink. The brand palette above.
- **midnight** — Steel blue/teal. Late-night hacking.
- **neon** — Green/cyan. Cyberpunk terminal.
- **mono** — Grayscale. When you want output, not vibes.

Set via `theme = "egirl"` in `egirl.toml` (root level). All CLI output — logger, prompts, help text, status — uses the active theme through `colors()` from `src/ui/theme.ts`.

### Principles

- **256-color ANSI** — No external color libraries. Raw `\x1b[38;5;{n}m` sequences. Works in every modern terminal.
- **Theme-aware, not theme-dependent** — Output is readable even without color support. Never encode meaning in color alone.
- **Semantic color roles** — Don't hardcode ANSI codes in display files. Import `colors()` and use named roles (`primary`, `secondary`, `error`, etc.).
- **Consistent hierarchy** — `BOLD` for brand name. `primary` for section headers. `accent` for commands/keywords. `DIM` for metadata. `muted` for noise.
- **HTML docs** — When generating HTML documentation or manuals, use the same hex palette. Purple (`#af5fd7`) for headings, pink (`#ff5faf`) for accents, dark background (`#1a1a2e`) for code blocks.

## What NOT to Build

- No WebSocket gateway (Discord.js handles its connection, CLI is stdio)
- No channel abstraction layer (hardcode Discord and CLI)
- No plugin system for providers (three files, three classes)
- No skill gating/permissions
- No session persistence across restarts (v1)
- No streaming (v1)
- No multi-user anything

---

## Rules for Working in This Codebase

### Sacred Files

Workspace files are user data, not code. **Never modify without explicit permission**:
- `SOUL.md` — Personality definition
- `MEMORY.md` — Long-term curated facts
- `USER.md` — User profile
- `IDENTITY.md` — Name, emoji, identity config
- `AGENTS.md` — Operating instructions

These files belong to the user. Treat them like you'd treat someone's personal notes.

### Don't Be Helpful

No unsolicited changes. Specifically:
- No "while I was in here I also..." modifications
- No adding README sections that weren't requested
- No creating index.ts barrel files to "clean up" imports
- No refactoring adjacent code that "could be better"
- No adding comments, docstrings, or type annotations to code you didn't change
- No "improving" error handling in unrelated functions

Do exactly what was asked. Stop.

### When Uncertain

- **Ask** for architectural decisions, new dependencies, or changes that affect multiple files
- **Make a call** for implementation details, variable names, or local code structure
- When in doubt, ask. A 30-second clarification beats a 30-minute redo.

### Dependencies

Don't install new packages without asking first. If you think a new dependency is needed:
1. Explain what you need it for
2. List alternatives you considered
3. Wait for approval

The current stack is intentionally minimal. Respect that.

### Git Conventions

Commit messages: imperative mood, concise, no period at the end
```
Add memory search tool
Fix escalation threshold logic
Remove unused provider config
```

Branch naming (if applicable): `feature/thing`, `fix/thing`, `refactor/thing`

Batch related changes into single commits. Don't commit after every file change.

---

## Code Style

### TypeScript

- Prefer `interface` for object shapes (it's what the codebase uses)
- Use TypeBox for runtime validation, infer static types from schemas
- No `any` — use `unknown` and narrow with type guards
- Prefer explicit return types on exported functions
- Barrel exports (`index.ts`) only at module boundaries, not within modules

### Null vs Undefined

- Prefer `undefined` for absence in application code
- `null` is acceptable at external boundaries (SQLite, SDK responses)
- discord.js and bun:sqlite return `null` in places — don't fight it

### Error Handling

- Throw errors early, catch them at boundaries (agent loop, channel handlers)
- Use discriminated unions for expected failure states, not exceptions
- Never swallow errors silently — log them at minimum
- Tool execution errors should return `{ success: false, output: "..." }`, not throw

### Patterns to Follow

- One file = one concept. If a file exceeds ~200 lines, split it
- Functions over classes unless you need stateful instances
- Explicit dependencies via function parameters, not module-level singletons
- Config is loaded once at startup and passed down
- Use early returns to reduce nesting

### Patterns to Avoid

- No dependency injection frameworks
- No decorators
- No class inheritance hierarchies — composition only
- No `"use strict"` (TypeScript handles this)
- No default exports (named exports are greppable)
- No complex generics unless absolutely necessary

### Naming

- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE` only for true constants (not config values)
- Boolean variables: prefix with `is`, `has`, `should`, `can`

### Testing

- Tests live in `test/` directory, mirroring `src/` structure
- Use `bun:test` — no Jest, no Vitest
- Test behavior, not implementation
- Mock at module boundaries (providers, file system), not internal functions

### Verification

After making changes, always run all three checks before considering work complete:

```
bun test          # unit tests
bun run lint      # biome check (formatting + lint rules)
bun run typecheck # tsc --noEmit
```

All three must pass. Do not push code that fails any of these checks.
