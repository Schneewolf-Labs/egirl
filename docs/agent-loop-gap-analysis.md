# Agent Loop & Feature Gap Analysis

> egirl vs OpenClaw — what's missing, what's solid, what to steal

Date: 2026-02-15

---

## Executive Summary

egirl's agent loop is structurally sound. The core cycle (route → invoke → tool exec → loop) works, and several subsystems (memory, routing, context window) are well-engineered. But compared to OpenClaw's battle-tested loop, there are meaningful gaps in **resilience**, **observability**, **concurrency**, and **planning depth** that would make egirl significantly more capable if addressed.

This isn't about copying OpenClaw's architecture. Their gateway abstraction and multi-channel complexity are explicitly out of scope. But several of their patterns solve real problems we'll hit as egirl takes on longer, more complex tasks.

---

## What egirl Does Well (Keep)

These are solid and don't need rework:

| Area | Status |
|------|--------|
| Hybrid FTS + vector memory search | Strong. Cosine similarity + SQLite FTS with configurable thresholds |
| Proactive memory retrieval | Good. Injects relevant memories before each LLM turn |
| Real tokenizer integration | Excellent. llama.cpp `/tokenize` endpoint with caching beats estimation |
| Routing heuristics + escalation detection | Good. Confidence scoring, pattern matching, complexity estimation |
| Tool executor with safety hooks | Solid. Pre/post hooks, audit logging, confirm callbacks |
| Context window fitting with group preservation | Good. Tool-call/result groups stay together, sliding window |
| Qwen3 native chat template | Correct. Matches training format exactly |
| Workflow engine | Useful. YAML-defined multi-step chains with interpolation |
| Graceful degradation | Good. Every optional subsystem (embeddings, remote, memory, browser) has fallbacks |

---

## Critical Gaps

### 1. Pre-Compaction Memory Flush

**Problem:** When egirl's context window overflows and messages are dropped, it triggers async summarization of the dropped messages. But by that point, the raw messages are gone — the summary is a lossy compression done under pressure.

**OpenClaw's approach:** Before auto-compaction triggers, a silent agentic turn writes durable state to `memory/YYYY-MM-DD.md`. The agent explicitly decides what's worth preserving (decisions made, facts learned, task state) *before* the context is compressed. If nothing worth storing happened, the agent writes `NO_FLUSH` and skips.

**What to build:**
- Add a pre-compaction hook in the agent loop that triggers a memory flush turn
- Use local provider (zero API cost) to extract and persist critical state
- Only then proceed with context summarization
- Add `NO_FLUSH` pattern to skip unnecessary writes

**Impact:** High. Prevents silent context loss during long tasks.

---

### 2. Structured Observability (JSONL Transcripts)

**Problem:** egirl persists conversations to SQLite, which is fine for continuity but poor for debugging, replay, and understanding *why* the agent did what it did. Routing decisions, escalation events, tool timing, and token usage are logged to console but not durably recorded.

**OpenClaw's approach:** Every turn is logged to an append-only JSONL transcript. Each entry includes the full decision context: which model was selected, what tools were called, token counts, timing, routing rationale. This enables replay, cost analysis, and post-mortem debugging.

**What to build:**
- Structured JSONL logger alongside (not replacing) SQLite conversation store
- Log routing decisions, escalation checks, tool executions with timing, token usage per turn
- One file per session, append-only
- Simple replay tool that can re-render a session from its transcript

**Impact:** Medium-high. Critical for debugging multi-turn failures and understanding agent behavior.

---

### 3. Explicit Planning Step

**Problem:** egirl's agent loop is reactive: receive message → route → invoke LLM → maybe execute tools → loop. The LLM may implicitly plan inside its response, but there's no explicit decomposition step. For complex multi-step tasks, this leads to the agent stumbling forward one tool call at a time without a coherent strategy.

**OpenClaw's approach:** The loop includes an explicit Think → Plan → Act → Observe cycle. The plan is visible and revisable. Sub-agents can be spawned for parallel sub-tasks.

**What to build:**
- For tasks above a complexity threshold (from the existing router analysis), inject a planning prompt before tool execution
- Emit the plan as a structured object (steps, dependencies, expected outcomes)
- Track plan progress across turns — which steps are done, which failed, what to retry
- Surface the plan in CLI/Discord output so the user sees the strategy

**Impact:** High for complex tasks. Low priority for simple chat — the routing system already handles those well.

---

### 4. Sub-Agent Spawning

**Problem:** egirl can delegate to Claude Code via the `code_agent` tool, but can't decompose a complex task into parallel sub-tasks handled by multiple agent instances. Everything runs in a single serial loop.

**OpenClaw's approach:** `sessions_spawn` creates child agents that run in parallel in dedicated lanes. The parent orchestrates and synthesizes results. Child agents can use cheaper models for cost optimization.

**What to build:**
- Agent fork mechanism: spawn a child `AgentLoop` instance with its own context and turn limit
- Child agents share the memory store but get isolated conversation history
- Parent agent gets a tool (`spawn_agent`) that returns a handle; results come back as tool results
- Limit nesting depth (configurable, default 2)
- Use local provider for sub-agents when possible

**Impact:** Medium. Most valuable for research tasks, parallel file operations, and code review of multiple files.

---

### 5. Concurrency Control (Lane-like Serialization)

**Problem:** egirl's task system supports background tasks and cron scheduling, but there's no formal concurrency model. If a cron task and a user message both trigger agent runs simultaneously, they could race on shared state (conversation history, memory writes, file operations).

**OpenClaw's approach:** The Lane Queue system partitions work into orthogonal lanes (Main, Cron, Subagent, Nested). Runs are serialized per session key within each lane. This prevents race conditions by design.

**What to build:**
- Session-level mutex: only one agent loop run per session at a time
- Queue incoming messages during active runs (with a configurable strategy: queue, reject, interrupt)
- Separate lanes for user-initiated vs cron-initiated work
- Background task runner already exists — formalize its relationship to the main agent loop

**Impact:** Medium. Becomes critical once cron tasks and Discord passive monitoring are both active.

---

### 6. Model Failover Chains

**Problem:** egirl has basic retry with exponential backoff for transient errors, and falls back from remote to local if remote is unavailable. But there's no structured failover *across* remote providers or API key rotation within a provider.

**OpenClaw's approach:** Auth profile rotation (multiple API keys per provider, rotate on rate limit), cross-provider fallback chains (Claude → GPT → Gemini), exponential backoff per provider. The fallback chain is deliberately cross-provider since rate limits on one affect all models from that provider.

**What to build:**
- Support multiple API keys per provider in config (array instead of single string)
- Rotate keys on 429/rate limit responses
- Configurable fallback chain: `[anthropic, openai]` — try next provider when current is exhausted
- Track per-provider cooldown state

**Impact:** Medium. Matters when hitting rate limits during heavy usage. Low priority if API usage is light.

---

### 7. Thinking Levels / Reasoning Depth Control

**Problem:** egirl sends every request with the same reasoning expectations. Simple questions and complex architectural decisions get the same treatment.

**OpenClaw's approach:** Configurable thinking levels (off/minimal/low/medium/high/xhigh) adjustable per session via `/think <level>`. This maps to model parameters (temperature, system prompt instructions, extended thinking tokens).

**What to build:**
- Map routing complexity (trivial/simple/moderate/complex) to thinking depth
- For local models: adjust temperature and add/remove chain-of-thought instructions
- For Anthropic: use extended thinking when available for complex tasks
- User-controllable override via CLI command

**Impact:** Low-medium. Nice quality-of-life improvement. The routing system already handles most of this implicitly by choosing local vs remote.

---

### 8. Semantic Browser Snapshots

**Problem:** egirl has browser tools (navigate, click, fill, snapshot) but the snapshot implementation likely returns raw screenshots or DOM content. Screenshots are token-expensive (thousands of tokens for a single page). Raw DOM is noisy.

**OpenClaw's approach:** Parses the accessibility tree (ARIA) into compact text-based "semantic snapshots" with element references (`@e1`, `@e2`). Achieves 60–93% fewer tokens compared to screenshots while being more accurate for navigation tasks.

**What to build:**
- Add accessibility tree extraction to `browser_snapshot`
- Return compact element references instead of (or alongside) visual screenshots
- Use the compact format by default, full screenshot only when visual analysis is needed

**Impact:** Medium if browser automation is a priority. Low if browser usage is rare.

---

## Lower Priority Gaps

| Gap | Description | OpenClaw Has | Priority |
|-----|-------------|-------------|----------|
| **Session commands** | `/new`, `/reset`, `/compact` for explicit session control | Yes | Low — add as CLI commands |
| **Skill progressive disclosure** | Load only name/description at startup, read full body on demand | Yes | Low — current skill count is small |
| **Write-ahead delivery queue** | Crash recovery for message delivery | Yes | Low — single-user, local process |
| **JSONL skill format** | AgentSkills open standard for portability | Yes | Low — egirl skills already work |
| **Voice integration** | TTS/STT, wake word | Yes | Out of scope per CLAUDE.md |
| **Device nodes** | Camera, screen recording, location | Yes | Out of scope |
| **Multi-agent routing** | Different channels → different agents | Yes | Out of scope — single user |

---

## Recommended Priority Order

Based on impact and alignment with egirl's design philosophy (local-first, single-user, flat and readable):

1. **Pre-compaction memory flush** — Prevents silent data loss. Small change, high value.
2. **Structured JSONL transcripts** — Unlocks debugging and replay. Foundation for everything else.
3. **Concurrency control** — Session-level mutex. Prevents real bugs as task system matures.
4. **Explicit planning step** — Makes complex task handling dramatically better.
5. **Model failover chains** — API key rotation and cross-provider fallback.
6. **Sub-agent spawning** — Parallel task decomposition.
7. **Semantic browser snapshots** — Token efficiency for browser automation.
8. **Thinking levels** — Quality-of-life polish.

---

## What NOT to Steal from OpenClaw

Per the design philosophy in CLAUDE.md:

- **WebSocket gateway** — Discord.js and CLI handle their own connections. No abstraction layer.
- **Multi-channel abstraction** — Hardcode Discord and CLI. No channel interface polymorphism.
- **Plugin system for providers** — Three files, three classes. Done.
- **Skill gating/permissions** — Single user. Trust the user.
- **50+ channel connectors** — We need two. Maybe three with XMPP.
- **ClawHub/skill registry** — We're not building a marketplace.
- **Device nodes / companion apps** — Out of scope for a CLI/Discord agent.
