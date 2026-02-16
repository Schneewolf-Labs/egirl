# OpenClaw Heartbeat System — Analysis for egirl

Research into OpenClaw's heartbeat mechanism and whether it maps onto egirl's
architecture. TL;DR: the core idea is sound but egirl already has most of the
infrastructure. What's missing is the **workspace-driven wake** pattern, not the
scheduler.

---

## What OpenClaw's Heartbeat Actually Is

A heartbeat in OpenClaw is a **scheduled agent turn that runs in the main session
context**. On a configurable interval (default 30 minutes), the gateway:

1. Loads the `HEARTBEAT.md` file from the agent's workspace
2. Injects it as the user message into the agent session
3. Runs an LLM turn with the full conversation history available
4. If the agent responds with `HEARTBEAT_OK`, the response is dropped silently
5. If the agent responds with anything else, it's delivered to the configured channel

Key config options:
- `heartbeat.every` — interval string (`"30m"`, `"1h"`)
- `heartbeat.model` — cheaper model for heartbeat runs (broken in current release)
- `heartbeat.activeHours` — time window with timezone (`"9-17 America/New_York"`)
- `heartbeat.target` — which channel gets the output (`"last"`, channel ID)
- `heartbeat.prompt` — override the system prompt for heartbeat runs

### The HEARTBEAT_OK Protocol

The agent is instructed: if nothing needs attention, reply `HEARTBEAT_OK`. The
gateway strips this token and drops the message if the remaining content is under
`ackMaxChars` (default 300 chars). This prevents notification spam.

### The Rotating Check Pattern

A community pattern uses `heartbeat-state.json` to track which check type is
most overdue. Instead of running all checks every heartbeat, it rotates through:

| Check    | Frequency  | Time Window |
|----------|-----------|-------------|
| Email    | 30 min    | 9 AM - 9 PM |
| Calendar | 2 hours   | 8 AM - 10 PM |
| Tasks    | 30 min    | Anytime |
| Git      | 24 hours  | Anytime |
| System   | 24 hours  | 3 AM only |

Each heartbeat picks the most overdue check and runs only that one.

---

## Known Problems with OpenClaw's Approach

These are documented bugs and architectural critiques from the OpenClaw community:

1. **LLM waste**: ~85% of heartbeat calls return `HEARTBEAT_OK`. At 48 beats/day,
   that's ~41 wasted LLM calls. A detailed analysis estimates 245 unnecessary
   calls per agent per day at 5-minute intervals.

2. **System events cause rapid re-runs**: Discord reconnections, Slack message
   edits, and other system events get bundled into heartbeat prompts and trigger
   extra agent turns. Intervals drop from 1 hour to seconds.

3. **Model override is broken**: `heartbeat.model` is documented but ignored at
   runtime. Heartbeats use the main session model, which can be expensive.

4. **Empty file silently blocks manual triggers**: `openclaw system event --mode now`
   does nothing when `HEARTBEAT.md` is empty or comment-only.

5. **Runs in main session context**: The heartbeat shares conversation history
   with interactive use. This means heartbeat runs can pollute the conversation
   and heartbeat costs scale with session length.

---

## How egirl Compares

### What egirl already has

| Capability | OpenClaw Heartbeat | egirl Task Runner |
|-----------|-------------------|-------------------|
| Periodic execution | `heartbeat.every` interval | `tick_interval_ms` + per-task `intervalMs`/`cronExpression` |
| Business hours | `heartbeat.activeHours` | `task.businessHours` with `parseBusinessHours()` |
| Channel routing | `heartbeat.target` | `task.channel` + `task.channelTarget` |
| Notification control | `HEARTBEAT_OK` drop protocol | `task.notify` (always/on_change/on_failure/never) |
| Change detection | None (LLM decides) | `lastResultHash` diffing with SHA-256 |
| Error handling | Crash or retry | `classifyError()` + `getRetryPolicy()` with exponential backoff |
| Event triggers | System events only | File watcher, GitHub polling, webhooks, command diff |
| Model selection | `heartbeat.model` (broken) | Per-task uses local/remote via router |
| Proactive work | Heartbeat prompt only | `Discovery` class with idle detection |
| Task dependencies | None | `dependsOn` + `triggerDependents()` |
| Workflow execution | None (always LLM) | Workflow-first with LLM fallback |
| Timeout protection | None documented | `taskTimeoutMs` with Promise.race |
| Deduplication | None (causes rapid re-runs) | 10s `eventDedupeMs` window |

### What egirl is missing

The one thing OpenClaw's heartbeat does that egirl's task runner doesn't:
**workspace-file-driven wake instructions**.

OpenClaw treats `HEARTBEAT.md` as a living document — the user (or the agent
itself) writes what to check, and the heartbeat reads it every cycle. This
creates a simple contract: "put instructions in this file, agent follows them
on schedule."

egirl's equivalent would be a scheduled task whose prompt references a workspace
file. The mechanics exist (scheduled tasks + file reading tools), but the
**convention** doesn't. There's no standard "check this file for instructions"
pattern.

---

## Verdict: Does It Fit?

### The scheduler: No, we don't need it

egirl's `TaskRunner` with `tick()` + cron + business hours + event sources is
strictly more capable than OpenClaw's heartbeat timer. OpenClaw's heartbeat is
a single interval for a single purpose. egirl can run N independent scheduled
tasks with different intervals, triggers, and constraints.

### The workspace-driven pattern: Yes, worth stealing

The `HEARTBEAT.md` convention is genuinely useful. A file in the workspace that
the agent checks periodically:

- Users can edit it without touching config or code
- The agent can update it (add/remove checks as context changes)
- It's visible, auditable, version-controlled
- It degrades gracefully — empty file means nothing to do

### The HEARTBEAT_OK protocol: No, `on_change` is better

OpenClaw's approach asks the LLM to output a magic string when there's nothing
to report. This wastes tokens every time. egirl's `on_change` notification mode
with result hashing is strictly better — if the result hasn't changed, don't
notify. No magic strings, no wasted LLM decisions.

### The rotating check pattern: Maybe, but tasks are cleaner

The rotating heartbeat pattern (email, calendar, git, etc.) is solving a problem
that separate tasks handle better. In egirl, each check would be its own task
with its own interval and business hours. No need for a state file to track
rotation — the scheduler does that.

### Deterministic pre-checks: Yes, but as a workflow

The architectural critique that ~85% of heartbeat LLM calls are wasted is valid.
The proposed fix (deterministic pattern matching before invoking LLM) maps
directly to egirl's workflow-first execution. A task with a `workflow` definition
can do cheap deterministic checks (regex a file, check a condition) and only
invoke the agent loop if something actually needs attention.

---

## Recommendation

Don't build a heartbeat system. Instead, build the **convention** on top of
what already exists.

### 1. Add a `HEARTBEAT.md` convention

Create a workspace template for `HEARTBEAT.md` with a standard format:

```markdown
# Heartbeat Checks

- [ ] Check CI status on main branch
- [ ] Review open PRs older than 2 days
- [x] Monitor disk usage (completed, remove when no longer needed)
```

### 2. Ship a built-in "heartbeat" task template

A pre-configured scheduled task that:
- Reads `HEARTBEAT.md` from the workspace
- Uses a workflow step to check if there are unchecked items (deterministic, no LLM)
- Only invokes the agent if there's work to do
- Updates the file with results
- Notifies `on_change`

Config:
```toml
# User adds to egirl.toml or agent creates via task_propose
[tasks.heartbeat]
kind = "scheduled"
cron_expression = "*/30 * * * *"  # Every 30 minutes
business_hours = "9-18 Mon-Fri"
notify = "on_change"
```

### 3. Skip everything else

- No `HEARTBEAT_OK` protocol (use `on_change`)
- No main-session heartbeat context (isolated task sessions are better)
- No rotating check state file (separate tasks with separate schedules)
- No model override config (local model is already cheap/free)

### Estimated effort

~40 lines for the workflow definition that does deterministic pre-checking
of `HEARTBEAT.md`, plus a template file. The scheduler, execution engine,
notification system, and business hours support already exist.

---

## Sources

- [OpenClaw Heartbeat Docs](https://docs.openclaw.ai/gateway/heartbeat)
- [Heartbeat Bug: Rapid Re-runs — #2804](https://github.com/openclaw/openclaw/issues/2804)
- [Heartbeat Bug: Model Override Ignored — #14279](https://github.com/openclaw/openclaw/issues/14279)
- [Heartbeat Bug: Empty File Blocks Manual Trigger — #14527](https://github.com/openclaw/openclaw/issues/14527)
- [OpenClaw Architecture Analysis (jghankins)](https://gist.github.com/jghankins/79a8211a0ba7ffd92153ad2ecd80c3f6)
- [Rotating Heartbeat Example (digitalknk)](https://github.com/digitalknk/openclaw-runbook/blob/main/examples/heartbeat-example.md)
