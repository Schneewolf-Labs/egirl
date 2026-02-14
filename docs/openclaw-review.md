# OpenClaw Feature Review for egirl

Recon report from infiltrating the OpenClaw codebase (`github.com/openclaw/openclaw`).
The goal: identify ideas worth stealing and patterns worth avoiding.

**Scale comparison:**
- egirl: ~96 source files, 34 tests, 4 channels, 18 tools, 3 providers
- OpenClaw: ~2,900 source files, 367 tests, 15+ channels, 36 extensions, 51 skills, 8+ providers

OpenClaw is a general-purpose multi-user agent platform. egirl is a single-user,
local-first work tool. Different goals, but some of their solutions are genuinely good.

---

## Worth Stealing

### 1. Auth Profile Rotation with Cooldown Tracking

**What they do:** Multiple API keys per provider with automatic rotation. When a key
gets rate-limited or returns auth errors, it goes into exponential cooldown
(1min -> 5min -> 25min -> 1hr cap). Billing errors get even longer cooldowns
(5hr base, 24hr max). Round-robin within available keys, with type preference
(oauth > token > api_key). Tracks `lastUsed`, `cooldownUntil`, `errorCount` per profile.

**Why it's good:** If you have a personal key and an org key for Anthropic, or multiple
OpenAI keys, this prevents the agent from hammering a rate-limited key. The exponential
backoff is simple and correct. Billing errors getting longer cooldowns is a nice touch.

**egirl adaptation:** We only need the simple version. Store multiple API keys per
provider in config, rotate on 429/auth errors, track cooldown with timestamp. Skip
the file-locking and OAuth complexity. Maybe 50 lines of code.

**Priority: Medium** - Useful once you actually hit rate limits regularly.

---

### 2. Model Fallback Chains with Error Classification

**What they do:** Classify errors into categories (auth, rate_limit, billing, timeout,
context_overflow, format) using regex patterns against error messages. Based on the
category, decide whether to failover to the next model in a configured fallback chain,
retry with the same model, or throw immediately.

```
Rate limit on claude-opus → try claude-sonnet → try gpt-4o → fail
Auth error → try next API key, then try next model
Context overflow → compact history, retry same model
Timeout → don't retry (user probably cancelled)
```

**Why it's good:** Not all errors are equal. A rate limit means "try something else."
A context overflow means "shrink and retry." An auth error means "your key is bad."
Treating them all the same is wasteful.

**egirl adaptation:** We already have mid-conversation escalation (local -> remote).
Adding error classification to the provider layer would make fallback smarter. The
regex patterns for error classification are directly portable.

**Priority: Medium** - Our escalation system handles the common case. This would
handle edge cases more gracefully.

---

### 3. Cron / Scheduled Agent Tasks

**What they do:** Persistent scheduled tasks with three schedule types:
- `at`: one-shot ISO timestamp
- `every`: interval with anchor (prevents drift)
- `cron`: standard cron expressions with timezone

Jobs can either inject a system event into the main session or run an isolated agent
turn with its own context. Isolated jobs can optionally deliver results to a channel.
Exponential backoff on errors (30s -> 60s -> 5m -> 15m -> 60m). Survived restarts.

**Why it's good:** An agent that can schedule its own work is significantly more useful.
"Remind me about X tomorrow", "Check CI status every 30 minutes", "Run the standup
summary at 9am" - these are real workflows.

**egirl adaptation:** Implement a simple cron service backed by SQLite. Support `at`
and `every` schedules (skip cron expressions for v1). Add a `schedule_task` tool
so the agent can create its own scheduled work. Store in the existing SQLite db.

**Priority: High** - This is a force multiplier for a personal agent.

---

### 4. SKILL.md Metadata: Requirements Declaration

**What they do:** Skills declare their requirements in YAML frontmatter:
```yaml
metadata:
  openclaw:
    requires:
      bins: ["gh"]           # Required CLI tools
      env: ["GITHUB_TOKEN"]  # Required env vars
      config: ["channels.discord.token"]
    install:
      - kind: "brew"
        formula: "gh"
```

Skills that don't meet requirements are silently excluded. No error, no broken
tool calls - they just don't show up.

**Why it's good:** Prevents the agent from trying to use tools it can't actually run.
No more "I'll use the github tool" when `gh` isn't installed. The install hints
are a nice touch for discoverability.

**egirl adaptation:** We already have a skill format. Adding `requires` to the
frontmatter is trivial. Check requirements at load time, filter out unmet skills.
Maybe 30 lines of validation code.

**Priority: High** - Simple to implement, prevents frustrating failures.

---

### 5. Hooks System (Before/After Tool Calls)

**What they do:** Event-driven hooks at key lifecycle points:
- `before_tool_call` / `after_tool_call`
- `agent:bootstrap`
- `message_received`

Hooks are loaded from workspace directories, filtered by OS/binary requirements,
and executed sequentially. Errors in hooks don't crash the agent.

**Why it's good:** Lets users customize behavior without modifying core code. Example:
auto-commit after every file write, log all tool calls to a file, send notifications
on certain events.

**egirl adaptation:** We already have event hooks in the agent loop. Exposing them
to user-defined scripts (JS/TS files in workspace) would be the next step. The
loading pattern (scan directory, validate, register) is clean.

**Priority: Low** - Nice to have, but the single-user nature of egirl means you
can just modify the code directly.

---

### 6. Browser Automation via Playwright

**What they do:** HTTP API wrapping Playwright. Agents can navigate, click, type,
screenshot, and evaluate JS. Uses accessibility roles for element references instead
of CSS selectors (much more robust). Supports multiple browser profiles and tabs.

**Why it's good:** Web research, form filling, CI monitoring, dashboard scraping -
a browser tool opens up a lot of useful workflows. The accessibility-role approach
for element targeting is smart: `ref: "button/Submit"` is way more resilient than
`#submit-btn`.

**egirl adaptation:** This is a big feature. Worth stealing the architecture
(HTTP server wrapping Playwright, accessibility-based targeting) but building our
own simpler version. Skip multi-profile, skip the full Express server. A tool that
launches headless Chrome, takes snapshots, and lets the agent interact.

**Priority: Medium** - Useful but substantial to implement. Consider after core
features are solid.

---

### 7. Session Cost Tracking with Cache Breakdown

**What they do:** Track token usage per session with cache-aware cost calculation:
- Input tokens, output tokens, cache read tokens, cache write tokens
- Per-model cost rates applied to each token type
- Daily usage breakdowns
- Tool call frequency tracking
- Session-level cost aggregation

**Why it's good:** Knowing "this conversation cost $0.47, of which $0.12 was cache
misses" is actionable information. Helps tune routing thresholds.

**egirl adaptation:** We already have basic usage tracking. Adding cache-aware cost
calculation and daily aggregation would make it more useful. The data model is
straightforward: extend our existing tracking with cache token fields.

**Priority: Low** - We have basic tracking. This is polish.

---

## Interesting But Not Applicable

### 8. Gateway Architecture (WebSocket Control Plane)

**What they do:** Centralized WebSocket server that all clients (CLI, mobile apps,
web UI) connect to. Handles session routing, plugin loading, auth, and RPC.

**Why we skip it:** egirl is single-user. Discord.js handles its own WebSocket.
CLI is stdio. A gateway adds a process to manage and a protocol to debug for
zero benefit. This is the "50-layer gateway abstraction" CLAUDE.md warns about.

---

### 9. 15+ Channel Integrations

**What they do:** WhatsApp, Telegram, Slack, Signal, iMessage, IRC, Matrix,
Microsoft Teams, Line, Feishu/Lark, Google Chat, Zalo, BlueBubbles...

**Why we skip it:** egirl needs Discord and CLI. Maybe XMPP. Each channel
integration is ~500 lines of code and ongoing maintenance. Breadth for its own
sake. Build the ones you use; ignore the rest.

---

### 10. Device Pairing Protocol

**What they do:** QR code / token-based pairing for mobile apps to connect to the
gateway. Includes Tailscale integration for remote access.

**Why we skip it:** No mobile app, no gateway, no need. If you want egirl on your
phone, SSH into your box and use the CLI.

---

### 11. Web UI / Control Panel

**What they do:** Lit-based web app with tabs for chat, agents, sessions, channels,
skills, cron, logs, and config. Real-time updates via WebSocket to gateway.

**Why we skip it:** egirl's UI is Discord and terminal. A web dashboard is a whole
separate frontend to maintain. If you need to see logs, `tail -f`. If you need
to change config, edit the TOML.

---

### 12. Plugin SDK with Manifest System

**What they do:** Full plugin system with manifest files, runtime discovery, type
definitions, hook registration, gateway method registration. Plugins can add
channels, memory backends, tools, etc.

**Why we skip it:** Three users would need this. egirl is one codebase for one team.
Add features directly. A plugin system is overhead without an ecosystem.

---

## Not Worth Stealing (Anti-Patterns for egirl)

### 13. Zod + TypeBox Both

**What they do:** Use both Zod (v4) and TypeBox for runtime validation. 22,000+
lines of Zod schema definitions alone.

**Why it's bad for us:** Pick one. We use TypeBox. It's fine. Having two validation
libraries means two mental models and twice the schema maintenance.

---

### 14. pnpm Monorepo with Workspace Packages

**What they do:** Monorepo with pnpm workspaces: main package, UI package, 36
extension packages, 51 skill packages.

**Why it's bad for us:** egirl is one package. It should stay one package. Monorepo
tooling adds build complexity, version management, and dependency resolution
headaches. We're not shipping packages to npm.

---

### 15. Pi Agent SDK Dependency

**What they do:** Delegate the entire agent loop to `@mariozechner/pi-agent-core`
and `@mariozechner/pi-ai`. The agent loop is event-driven through the SDK rather
than being explicit in their code.

**Why it's bad for us:** Our agent loop is ~500 lines and we understand every line.
Delegating core logic to a third-party SDK means debugging through someone else's
abstraction. For a single-user tool, owning the loop is a feature.

---

### 16. Express 5 for Internal HTTP

**What they do:** Use Express 5 for the browser control server, gateway HTTP
endpoints, and various internal APIs.

**Why it's bad for us:** Bun has built-in HTTP serving. Adding Express means adding
a dependency, its middleware model, and its request/response types. For internal
HTTP (if we ever need it), `Bun.serve()` is sufficient.

---

### 17. Dynamic Plugin Loading via Jiti

**What they do:** Runtime TypeScript loading with cache-busting (`?t=Date.now()`).

**Why it's bad for us:** We compile with Bun. Skills are loaded at startup. Dynamic
runtime TS compilation adds startup latency and failure modes. If a skill needs
to be loaded, it should be compiled.

---

### 18. Multi-Agent Group Chat

**What they do:** Multiple agents in the same conversation, with session key routing
and subagent spawning.

**Why it's bad for us:** We have one agent. It's egirl. She doesn't need to talk
to herself. The `code_agent` delegation tool handles the "I need a specialist"
case without the complexity of multi-agent orchestration.

---

## Summary: The Steal List

| Feature | Effort | Priority | Lines (est.) |
|---------|--------|----------|--------------|
| Cron/scheduled tasks | Medium | High | ~200 |
| Skill requirements declaration | Low | High | ~30 |
| Auth profile rotation | Low-Medium | Medium | ~100 |
| Error classification for fallback | Low | Medium | ~80 |
| Browser automation (Playwright) | High | Medium | ~400 |
| Session cost tracking (enhanced) | Low | Low | ~50 |
| User-defined hooks | Medium | Low | ~150 |

Total estimated new code: ~1,000 lines for the high+medium priority items.

The main takeaway: OpenClaw's best ideas are about **resilience** (auth rotation,
error classification, fallback chains) and **autonomy** (cron, scheduled tasks).
Their worst patterns are about **abstraction** (gateway, plugin SDK, multi-agent).
egirl should steal the former and ignore the latter.
