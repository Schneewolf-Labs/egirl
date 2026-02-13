# Next Priorities

Analysis of egirl's current state and the highest-impact work to do next.

The core infrastructure is feature-complete: agent loop, 3 providers, smart routing, hybrid memory, 3 channels, 8+ tools, config, tracking, tests, docs, and CI all work. The gaps below are about **wiring existing pieces together** and **adding tools for real work**.

---

## P1: Wire Skills into the Agent

The `SkillManager`, parser, and loader all exist and work — but they're never used. `src/index.ts` never instantiates a SkillManager. The system prompt in `src/agent/context.ts` hardcodes the tool list instead of reading from the tool executor.

**Impact:** Until this is wired up, adding capabilities requires editing source code instead of dropping in a skill file. The entire skills subsystem is dead code.

**Work:**
- Instantiate `SkillManager` in `src/index.ts`, load from configured `skills.dirs`
- Inject enabled skill content into the system prompt (via `buildSystemPrompt`)
- Implement `loadFromSkill` in `src/tools/loader.ts` to register skill-defined tools
- Make the system prompt tool list dynamic (read from `ToolExecutor.getDefinitions()`)

**Files:** `src/index.ts`, `src/agent/context.ts`, `src/tools/loader.ts`

---

## P2: Web/Research Tools

The agent cannot fetch URLs or search the web. For research and technical problem-solving — stated core use cases — this is the biggest functional gap. Escalation to Claude/GPT works but has knowledge cutoffs and costs money.

**Work:**
- Add `fetch_url` builtin tool (HTTP GET → markdown-converted content)
- Optionally add `web_search` tool (search API integration)
- These are builtins, not skills — they're fundamental capabilities

**Files:** New files in `src/tools/builtin/`

---

## P3: Proactive Memory Retrieval

Memory works but is purely reactive. The user must explicitly ask "search memory for X." A useful agent would automatically recall relevant context before responding.

**Work:**
- Add pre-response memory lookup in the agent loop
- Use routing heuristics (which already detect task type) to decide when to search
- Inject memory results as additional system context, not tool calls
- Keep it lightweight — skip for simple greetings, trigger for task-specific messages

**Files:** `src/agent/loop.ts`, possibly `src/agent/context.ts`

---

## P4: Git-Aware Tools

`execute_command` can run git, but structured git tools with LLM-friendly output would improve code review workflows. Raw terminal dumps waste context window; parsed, truncated output is more useful.

**Work:**
- Add `git_diff` tool (structured diff with optional path/ref filtering)
- Add `git_log` tool (formatted commit history, truncated)
- Add `git_show` tool (single commit details)
- Output should be pre-trimmed for context window efficiency

**Files:** New files in `src/tools/builtin/`

---

## P5: Conversation Persistence

Every session starts blank. The agent can't reference yesterday's discussion. Even minimal persistence would make interactions cumulative.

**Work:**
- After conversations, extract key facts and store via memory system
- On session start, load recent conversation summaries as context
- Append-only — not session replay, just fact extraction
- Use the local model to summarize (this is a `memory_op`, stays local)

**Files:** `src/agent/loop.ts`, `src/memory/`

---

## Quick Wins (low effort, real impact)

| Issue | Fix | File |
|-------|-----|------|
| System prompt hardcodes tool list | Read from `ToolExecutor.getDefinitions()` | `src/agent/context.ts:62-74` |
| Screenshot tool not in system prompt | Add to tool list (or make it dynamic, per above) | `src/agent/context.ts` |
| Empty bundled skills directory | Ship 2-3 default skills (code-review, explain-code) | `src/skills/bundled/` |
| Stats have no viewer | Add `egirl stats` subcommand to show usage history | `src/index.ts`, `src/tracking/` |
