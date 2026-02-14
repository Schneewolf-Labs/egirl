# Background Task Framework

## Problem

The agent is purely reactive — it only does work when a user sends a message. It has no way to:

- Run something on a schedule ("check CI every 30 minutes")
- Watch for events and react (new PR opened, build failed, file changed)
- Send unprompted messages ("hey, that deploy finished" or "the tests you asked about are passing now")
- Find useful work to do during idle time

For Discord especially, a colleague who only speaks when spoken to is less useful than one who can ping you when something matters.

## Design

### Core Concepts

**Task**: A unit of background work with a prompt, a schedule, and a place to report results. Tasks are prompt-based — the agent uses its normal tool-calling loop to execute them, not hardcoded logic.

**TaskStore**: SQLite table that persists tasks across restarts. Same pattern as `ConversationStore` and `MemoryIndexer`.

**TaskRunner**: A timer loop that picks up due tasks, runs them through a dedicated `AgentLoop`, and delivers results to the appropriate channel.

**Outbound**: Channels gain a `send()` method so background work can push messages without a user prompt.

### Architecture

```
                    ┌─────────────┐
                    │  TaskStore   │  (SQLite)
                    │  tasks.db    │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ┌────▼───┐  ┌────▼───┐  ┌────▼────┐
         │Scheduled│  │ Event  │  │One-shot │
         │  Timer  │  │Sources │  │  Queue  │
         └────┬───┘  └────┬───┘  └────┬────┘
              │            │            │
              └────────────┼────────────┘
                           │
                    ┌──────▼──────┐
                    │ TaskRunner  │
                    │ (AgentLoop) │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Outbound   │
                    │  Messaging  │
                    └─────────────┘
```

## Data Model

### `tasks` table

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,

  -- What kind of task
  kind TEXT NOT NULL,              -- 'scheduled' | 'event' | 'oneshot'
  status TEXT NOT NULL,            -- 'proposed' | 'active' | 'paused' | 'done' | 'failed'

  -- What to do (the agent prompt for this task)
  prompt TEXT NOT NULL,

  -- Scheduling (for kind='scheduled')
  interval_ms INTEGER,            -- run every N ms
  cron TEXT,                      -- or cron expression (future, not v1)

  -- Event config (for kind='event')
  event_source TEXT,              -- 'github' | 'file' | 'command'
  event_config TEXT,              -- JSON: source-specific config

  -- Execution tracking
  next_run_at INTEGER,            -- epoch ms, when to run next
  last_run_at INTEGER,
  run_count INTEGER DEFAULT 0,
  max_runs INTEGER,               -- null = unlimited, 1 = one-shot

  -- Notification
  notify TEXT DEFAULT 'on_change',-- 'always' | 'on_change' | 'on_failure' | 'never'
  last_result_hash TEXT,          -- for on_change diffing

  -- Where to report results
  channel TEXT NOT NULL,          -- 'discord' | 'cli'
  channel_target TEXT NOT NULL,   -- channel/user ID, or 'stdout'

  -- Provenance
  created_by TEXT NOT NULL,       -- 'user' | 'agent'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### `task_runs` table

```sql
CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL,           -- 'running' | 'success' | 'failure' | 'skipped'
  result TEXT,                    -- summary output
  error TEXT,
  tokens_used INTEGER DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
```

## Components

### 1. TaskStore (`src/tasks/store.ts`)

SQLite-backed CRUD for tasks and runs. Same pattern as `ConversationStore`.

```typescript
interface TaskStore {
  // CRUD
  create(task: NewTask): Task
  get(id: string): Task | undefined
  update(id: string, changes: Partial<Task>): void
  delete(id: string): void
  list(filter?: TaskFilter): Task[]

  // Scheduling
  getDueTasks(now: number): Task[]
  markRunStarted(taskId: string): TaskRun
  markRunCompleted(runId: string, result: RunResult): void

  // Lifecycle
  compact(maxAgeDays: number): void
  close(): void
}
```

### 2. TaskRunner (`src/tasks/runner.ts`)

The execution engine. Runs on a timer, picks up due tasks, executes them through an `AgentLoop` with a scoped-down tool set.

```typescript
interface TaskRunner {
  start(): void
  stop(): void

  // Manual triggers
  runNow(taskId: string): Promise<TaskRun>

  // State
  isRunning(): boolean
  currentTask(): Task | undefined
}
```

**Key behaviors:**

- **Tick interval**: Checks for due tasks every 30 seconds (configurable)
- **Concurrency**: One background task at a time. Local inference is single-threaded — running two agent loops simultaneously would thrash the GPU
- **Preemption**: Interactive user messages take priority. If a user sends a message while a background task is mid-execution, the runner pauses after the current tool call completes, lets the interactive request through, then resumes
- **Timeout**: Each task run has a max duration (default: 5 minutes). Prevents runaway loops
- **Retry**: Failed tasks retry once with backoff. After two consecutive failures, the task is paused and the user is notified

**Execution flow per task:**

```
1. Create a fresh AgentLoop with session ID "task:{taskId}"
2. Build a system prompt: "You are executing a background task. {task.description}"
3. Run the agent with task.prompt as the user message
4. Capture the final response content
5. Compare with last_result_hash (for on_change notification)
6. If notification criteria met → send to channel via Outbound
7. Update next_run_at based on schedule
```

### 3. Outbound Messaging

Channels need a way to send messages without an inbound user message triggering them.

**Channel interface addition:**

```typescript
interface OutboundChannel {
  send(target: string, message: string): Promise<void>
}
```

**Discord implementation:** The `DiscordChannel` already has the `Client` object. Add:

```typescript
async send(target: string, message: string): Promise<void> {
  // target is a channel ID or user ID
  const channel = await this.client.channels.fetch(target)
  if (channel?.isTextBased()) {
    const chunks = splitMessage(message, 2000)
    for (const chunk of chunks) {
      await channel.send(chunk)
    }
  }
}
```

**CLI implementation:** Print to stdout with a visual separator so background output doesn't get tangled with interactive I/O:

```
─── background: check-ci ────────────────────
CI pipeline #4521 passed. All 47 tests green.
──────────────────────────────────────────────
```

### 4. Task Tools (`src/tools/builtin/tasks.ts`)

Tools the agent can use during normal conversations to manage background work.

| Tool | Description |
|------|-------------|
| `task_add` | Create a new task (immediately active, user-initiated) |
| `task_propose` | Propose a task (status='proposed', needs approval) |
| `task_list` | List tasks by status |
| `task_pause` | Pause a running task |
| `task_resume` | Resume a paused task |
| `task_cancel` | Delete a task |
| `task_run_now` | Trigger a task immediately regardless of schedule |

**`task_add` params:**

```json
{
  "name": "string",
  "description": "string",
  "prompt": "string — what the agent should do each run",
  "kind": "scheduled | oneshot",
  "interval": "string — human-readable like '30m', '2h', '1d'",
  "notify": "always | on_change | on_failure | never",
  "max_runs": "number | null"
}
```

The channel and target are inferred from the current conversation context — if you're talking in Discord DMs, the task reports back there.

### 5. Proposal & Approval Flow

When the agent notices an opportunity for background work, it uses `task_propose` instead of `task_add`. Proposed tasks don't run until approved.

**Approval via Discord:**

The agent sends a message like:

> **Proposed task: watch-deploy**
> I noticed you kicked off a deploy to staging. Want me to watch it and let you know when it's done?
> React ✅ to approve, ❌ to dismiss.

The `DiscordChannel.onReaction` handler already exists. Wire it to:

```typescript
if (emoji === '✅' && isProposedTaskMessage(messageId)) {
  taskStore.update(taskId, { status: 'active' })
  // reply confirming activation
}
if (emoji === '❌' && isProposedTaskMessage(messageId)) {
  taskStore.delete(taskId)
}
```

**Approval via CLI:**

Print the proposal. User types `approve <taskId>` or `reject <taskId>`.

### 6. Discovery: Finding Work (`src/tasks/discovery.ts`)

A special scheduled "meta-task" that looks for useful work. Runs at low frequency during idle time (default: every 30 minutes, only when no interactive messages for 10+ minutes).

**How it works:**

1. Build a context with: recent conversation snippets, current git status, any open tasks, time of day
2. Prompt the agent: "Based on recent context, is there any useful background work I should propose? Consider: CI status, open PRs, pending TODOs mentioned in conversation, files that were being discussed. Only propose something if it's genuinely useful — don't make work for the sake of it."
3. If the agent produces `task_propose` calls → those go through the normal approval flow
4. If nothing useful → do nothing

**Guard rails:**

- Max 3 proposals per discovery run (prevent spam)
- Cooldown: don't re-propose something that was rejected in the last 24h
- Only runs when the user is "present" (had a message in the last 2 hours) — no point proposing tasks if nobody's around to approve them

## Config

New section in `egirl.toml`:

```toml
[tasks]
enabled = true
tick_interval_ms = 30000        # how often to check for due tasks
max_concurrent = 1              # background tasks at once
task_timeout_ms = 300000        # 5 min max per task run
discovery_enabled = true        # agent looks for work
discovery_interval_ms = 1800000 # 30 min
idle_threshold_ms = 600000      # 10 min idle before discovery runs
```

## Integration with Existing Systems

### Bootstrap (`src/bootstrap.ts`)

`AppServices` gains:

```typescript
interface AppServices {
  // ... existing fields ...
  taskStore: TaskStore | undefined
  taskRunner: TaskRunner | undefined
}
```

Created in `createAppServices()` after conversation store, similar pattern.

### Agent Loop

No changes to `AgentLoop` itself. Background tasks use the same `AgentLoop` class with a different session ID (`task:{taskId}`) and optionally restricted tools.

### Memory

Background task results can write to memory. The task agent has access to `memory_set`, so it can store findings ("CI pipeline #4521 results: all passed") for later retrieval in interactive conversations.

### Conversation Store

Task runs are persisted in `task_runs`, not in `conversations`. The task agent's conversation is ephemeral — it's rebuilt each run from the task prompt. This keeps the conversation store clean (no phantom "conversations" from background work).

### Routing

Background tasks default to local model. The normal escalation logic still applies — if the local model can't handle a task, it escalates to remote. But this should be rare; background tasks are typically simple (check a status, parse some output, diff two things).

## Examples

### "Check CI every 30 minutes"

User says: "Watch CI for the main branch and let me know if anything breaks"

Agent calls `task_add`:
```json
{
  "name": "watch-ci-main",
  "description": "Monitor CI pipeline for main branch",
  "prompt": "Check the CI status for the main branch. Run `gh run list --branch main --limit 5` and look at the status. If any runs failed since the last check, report which ones and what failed. If all passing, report nothing.",
  "kind": "scheduled",
  "interval": "30m",
  "notify": "on_change"
}
```

Every 30 minutes, the runner spins up an agent, runs the prompt, the agent calls `execute_command` with the `gh` command, parses the output, and reports back only if something changed.

### "Watch this deploy"

User kicks off a deploy and says "let me know when it's done."

Agent calls `task_add`:
```json
{
  "name": "watch-deploy-staging",
  "description": "Watch staging deploy progress",
  "prompt": "Check if the staging deploy is still in progress. Run `kubectl rollout status deployment/app -n staging --timeout=10s`. If the rollout is complete, report success. If it failed, report the error. If still in progress, report nothing.",
  "kind": "scheduled",
  "interval": "2m",
  "notify": "on_change",
  "max_runs": 30
}
```

Polls every 2 minutes, pings when done or failed, auto-stops after 30 checks (1 hour).

### Agent discovers work

During idle discovery, the agent sees recent conversation about a PR review:

> "I noticed PR #42 was discussed earlier but not merged. Want me to watch for CI results and review comments on it?"

Sends `task_propose`. User reacts ✅. Task activates.

### "Run tests on this branch when I push"

```json
{
  "name": "test-on-push",
  "description": "Run test suite when feature branch changes",
  "prompt": "Check `git log --oneline -1` for the feature/auth branch. If the HEAD commit changed since last check, run `bun test` and report results. If unchanged, do nothing.",
  "kind": "scheduled",
  "interval": "5m",
  "notify": "on_change"
}
```

Approximates a file-watch trigger with polling. True event-driven file watching (via `fs.watch`) is a later optimization.

## Module Layout

```
src/tasks/
├── store.ts          # TaskStore — SQLite CRUD, scheduling queries
├── runner.ts         # TaskRunner — timer loop, agent execution, preemption
├── discovery.ts      # Discovery logic — idle-time work finding
├── types.ts          # Task, TaskRun, NewTask, TaskFilter interfaces
└── index.ts          # createTaskStore, createTaskRunner exports
```

New tools:
```
src/tools/builtin/tasks.ts    # task_add, task_propose, task_list, etc.
```

Channel changes:
```
src/channels/types.ts          # Add OutboundChannel interface
src/channels/discord.ts        # Implement send()
src/channels/cli.ts            # Implement send()
```

## What This Doesn't Do (Yet)

- **True event-driven triggers**: Webhooks, `fs.watch`, GitHub webhook receiver. V1 uses polling to keep things simple. Event sources can be added later without changing the task model — just add new `event_source` types.
- **Cron expressions**: Interval-based only in v1. Cron parsing is a dependency we'd need to add.
- **Task chaining**: "When task A finishes, run task B." Not needed yet. Can be done later with a `depends_on` field.
- **Resource budgeting**: No token/cost caps per task. Relies on the timeout and max_runs limits for now.
- **Multi-channel delivery**: A task reports to one channel. Broadcasting to multiple channels isn't hard but isn't needed for single-user.

## Open Questions

1. **Should discovery run through the same routing as interactive messages?** Probably yes — it's just another agent invocation. But discovery should probably always use local to avoid burning API credits on speculative work.

2. **How should the CLI handle outbound messages during interactive input?** Options: (a) print above the input line and redraw the prompt, (b) queue and show on next enter, (c) just print inline and accept the visual interruption. Leaning toward (c) for simplicity.

3. **Should task prompts have access to the user's conversation history?** Probably not by default — that's a lot of context to load for a "check CI" task. But the agent has memory tools, so important context can be stored in memory and retrieved naturally.

4. **Max tasks limit?** Probably cap at ~20 active tasks to prevent the tick loop from getting bogged down. Most users will have 3-5.
