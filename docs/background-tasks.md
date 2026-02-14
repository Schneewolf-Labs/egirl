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

**Task**: A unit of background work with a prompt, a trigger, and a place to report results. Tasks are prompt-based — the agent uses its normal tool-calling loop to execute them, not hardcoded logic.

**Trigger**: What causes a task to run. Three types: scheduled (interval), event-driven (file change, webhook, GitHub event), or one-shot (run once and done).

**TaskStore**: SQLite table that persists tasks across restarts. Same pattern as `ConversationStore` and `MemoryIndexer`.

**TaskRunner**: Orchestrates task execution — manages timers, event source lifecycles, and runs tasks through a dedicated `AgentLoop`.

**EventSource**: A thing that watches for external events and fires a callback. File watchers, webhook receivers, GitHub polling, command output diffing.

**Outbound**: Channels gain a `send()` method so background work can push messages without a user prompt.

### Architecture

```
                    ┌─────────────┐
                    │  TaskStore   │  (SQLite)
                    │  tasks.db    │
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    ┌────▼────┐    ┌───────▼───────┐   ┌────▼────┐
    │Scheduled│    │ Event Sources │   │One-shot │
    │  Timer  │    │               │   │  Queue  │
    └────┬────┘    │ ┌───────────┐ │   └────┬────┘
         │         │ │ file watch│ │        │
         │         │ │ webhook   │ │        │
         │         │ │ github    │ │        │
         │         │ │ command   │ │        │
         │         │ └───────────┘ │        │
         │         └───────┬───────┘        │
         │                 │                │
         └─────────────────┼────────────────┘
                           │
                    ┌──────▼──────┐
                    │ TaskRunner  │
                    │ (AgentLoop) │
                    └──────┬──────┘
                           │
               ┌───────────┼───────────┐
               │           │           │
          ┌────▼───┐  ┌────▼───┐  ┌───▼────┐
          │Discord │  │  CLI   │  │  API   │
          │ send() │  │ print  │  │ (push) │
          └────────┘  └────────┘  └────────┘
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

  -- Memory context: keys the agent should load before running
  memory_context TEXT,            -- JSON array of memory keys, e.g. ["deploy-config", "ci-notes"]

  -- Scheduling (for kind='scheduled')
  interval_ms INTEGER,            -- run every N ms

  -- Event config (for kind='event')
  event_source TEXT,              -- 'file' | 'webhook' | 'github' | 'command'
  event_config TEXT,              -- JSON: source-specific config (see Event Sources)

  -- Execution tracking
  next_run_at INTEGER,            -- epoch ms, when to run next (scheduled only)
  last_run_at INTEGER,
  run_count INTEGER DEFAULT 0,
  max_runs INTEGER,               -- null = unlimited, 1 = one-shot
  consecutive_failures INTEGER DEFAULT 0,

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
  trigger_info TEXT,             -- JSON: what triggered this run (event payload, schedule tick, manual)
  tokens_used INTEGER DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
```

### `task_proposals` table

Tracks proposal state for the approval flow (maps Discord message IDs to task IDs, tracks rejections for cooldown).

```sql
CREATE TABLE task_proposals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  message_id TEXT,               -- Discord message ID (for reaction tracking)
  channel TEXT NOT NULL,
  channel_target TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'pending' | 'approved' | 'rejected'
  rejected_at INTEGER,           -- for 24h cooldown on re-proposals
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
```

## Components

### 1. TaskStore (`src/tasks/store.ts`)

SQLite-backed CRUD for tasks, runs, and proposals. Same pattern as `ConversationStore`.

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
  getEventTasks(): Task[]  // all active event-driven tasks

  // Run tracking
  createRun(taskId: string, triggerInfo?: unknown): TaskRun
  completeRun(runId: string, result: RunResult): void
  getRecentRuns(taskId: string, limit?: number): TaskRun[]

  // Proposals
  createProposal(taskId: string, channel: string, target: string, messageId?: string): TaskProposal
  getProposalByMessage(messageId: string): TaskProposal | undefined
  wasRecentlyRejected(name: string, withinMs: number): boolean

  // Lifecycle
  compact(maxAgeDays: number): void
  close(): void
}
```

### 2. Event Sources (`src/tasks/events/`)

Each event source watches for something and fires a callback when triggered. Sources are started/stopped by the `TaskRunner` based on task lifecycle.

```typescript
interface EventSource {
  /** Start watching. Calls onTrigger when the event fires. */
  start(onTrigger: (payload: EventPayload) => void): void
  stop(): void
}

interface EventPayload {
  source: string       // 'file' | 'webhook' | 'github' | 'command'
  summary: string      // human-readable: "file changed: src/index.ts"
  data: unknown        // raw event data (passed to agent as context)
}
```

#### File Watcher (`src/tasks/events/file-watcher.ts`)

Uses Bun's native file watching (`fs.watch` or `Bun.file` watcher).

```typescript
// event_config schema:
interface FileWatchConfig {
  paths: string[]                 // files or directories to watch
  recursive?: boolean             // watch subdirectories (default: true)
  ignore?: string[]               // glob patterns to ignore (e.g. ["node_modules/**", ".git/**"])
  debounce_ms?: number            // coalesce rapid changes (default: 1000)
}
```

**Example config:**
```json
{
  "paths": ["src/", "test/"],
  "ignore": ["**/*.log", "node_modules/**"],
  "debounce_ms": 2000
}
```

**Debouncing**: File changes often come in bursts (editor save writes temp files, git checkout changes many files at once). The watcher collects all changes within the debounce window and fires once with the full list.

#### Webhook Receiver (`src/tasks/events/webhook.ts`)

Registers an HTTP endpoint on the API server. When a POST hits the endpoint, the task triggers.

```typescript
// event_config schema:
interface WebhookConfig {
  path: string                    // URL path, e.g. "/hooks/deploy"
  secret?: string                 // HMAC secret for payload verification
  filter?: string                 // jq-style expression to match (future)
}
```

**How it works:**
- When a webhook-type task activates, the `TaskRunner` calls `apiServer.addWebhookRoute(path, callback)`
- When the task is paused/deleted, the route is removed
- The API server exposes `addWebhookRoute` / `removeWebhookRoute` for dynamic route management
- If the API server isn't running, webhook tasks fail to activate with a clear error message

**Webhook route handler:**
```typescript
// POST /hooks/:path
async function handleWebhook(req: Request): Promise<Response> {
  // Verify HMAC signature if secret is configured
  // Parse JSON body
  // Fire onTrigger with payload
  // Return 200 OK
}
```

**Security**: Webhooks only listen on the configured API host (default `127.0.0.1`). Not exposed to the internet unless the user configures it that way. HMAC verification is optional but recommended for anything receiving external payloads.

#### GitHub Events (`src/tasks/events/github.ts`)

Polls GitHub via the `gh` CLI. This is deliberate — it avoids requiring webhook infrastructure, works behind firewalls, and `gh` is already authenticated.

```typescript
// event_config schema:
interface GitHubEventConfig {
  repo?: string                   // owner/repo (default: current repo from git remote)
  events: GitHubEventType[]       // what to watch for
  ref?: string                    // branch filter (for push/ci events)
  poll_interval_ms?: number       // override tick interval for this source (default: 60000)
}

type GitHubEventType =
  | 'push'           // new commits on a branch
  | 'pr_opened'      // new PR
  | 'pr_review'      // new review or comment on a PR
  | 'pr_merged'      // PR merged
  | 'ci_complete'    // workflow run finished
  | 'ci_failed'      // workflow run failed
  | 'issue_opened'   // new issue
  | 'issue_comment'  // new comment on an issue
  | 'release'        // new release published
```

**Implementation**: Each event type maps to a `gh` command:

| Event | Command | Diffing |
|-------|---------|---------|
| `push` | `gh api repos/{repo}/commits?sha={ref}&per_page=1` | compare HEAD SHA |
| `pr_opened` | `gh pr list --state open --json number,createdAt` | compare count/latest |
| `pr_review` | `gh pr view {number} --json reviews,comments` | compare review count |
| `ci_complete` | `gh run list --branch {ref} --limit 1 --json status,conclusion` | compare run ID + status |
| `ci_failed` | same as ci_complete | filter for `conclusion=failure` |
| `issue_opened` | `gh issue list --state open --json number,createdAt` | compare count/latest |
| `release` | `gh release list --limit 1` | compare tag name |

The source maintains a snapshot of the last-seen state. On each poll, it compares and fires if anything changed. The snapshot is stored in the task's `last_result_hash` field.

**Why not GitHub webhooks?** You can use them — configure a `webhook` event source pointing at `/hooks/github` and set up the webhook on GitHub. But the poll approach works out of the box with zero setup, which fits the local-first philosophy. Most events don't need sub-second latency.

#### Command Diff (`src/tasks/events/command.ts`)

Runs a shell command periodically, triggers when the output changes. The Swiss army knife — anything you can check with a command becomes an event source.

```typescript
// event_config schema:
interface CommandEventConfig {
  command: string                 // shell command to run
  poll_interval_ms?: number       // how often to run (default: 30000)
  shell?: string                  // shell to use (default: "bash")
  diff_mode?: 'full' | 'exit_code' | 'hash'  // how to detect change (default: 'hash')
}
```

**Diff modes:**
- `hash`: SHA-256 of stdout. Triggers when hash changes. Good for "did anything change?"
- `full`: Keep full stdout, include a diff in the event payload. Good for "what changed?"
- `exit_code`: Only trigger when exit code changes (e.g., 0 → 1). Good for pass/fail checks

**Example**: Watch for new Docker containers:
```json
{
  "command": "docker ps --format '{{.Names}}'",
  "poll_interval_ms": 10000,
  "diff_mode": "full"
}
```

### 3. TaskRunner (`src/tasks/runner.ts`)

The execution engine. Manages scheduled task timers, event source lifecycles, and runs tasks through an `AgentLoop`.

```typescript
interface TaskRunner {
  start(): void
  stop(): void

  // Manual triggers
  runNow(taskId: string): Promise<TaskRun>

  // Event source management
  registerEventSources(task: Task): void
  unregisterEventSources(taskId: string): void

  // State
  isRunning(): boolean
  currentTask(): Task | undefined
  isIdle(): boolean
}
```

**Key behaviors:**

- **Tick interval**: Checks for due scheduled tasks every 30 seconds (configurable via `tick_interval_ms`)
- **Concurrency**: One background task at a time. Local inference is single-threaded — running two agent loops simultaneously would thrash the GPU
- **Preemption**: Interactive user messages take priority. If a user sends a message while a background task is mid-execution, the runner yields after the current tool call completes, lets the interactive request through, then resumes
- **Timeout**: Each task run has a max duration (configurable via `task_timeout_ms`, default: 5 min). Prevents runaway loops
- **Retry**: Failed tasks increment `consecutive_failures`. After 2 consecutive failures, the task is paused and the user is notified. Successful runs reset the counter
- **Event queue**: When event sources fire while a task is already running, events are queued (bounded, newest wins for same-task events). Prevents pile-up from chatty file watchers

**Execution flow per task:**

```
1. Load memory context: if task.memory_context is set,
   fetch those memory keys and include as system context
2. Create a fresh AgentLoop with session ID "task:{taskId}"
3. Build system prompt:
   "You are executing a background task: {task.description}
    Use memory tools to store any findings worth remembering.
    If you need context from previous runs, search memory."
4. If triggered by event, prepend event payload to user message:
   "[Event: {payload.summary}]\n{payload.data}\n\n{task.prompt}"
5. Run the agent with the prompt
6. Capture the final response content
7. Hash the result, compare with last_result_hash (for on_change notification)
8. If notification criteria met → send to channel via Outbound
9. Update scheduling state (next_run_at, run_count, last_run_at)
10. If max_runs reached → set status to 'done'
```

**Memory integration**: Task prompts have access to the full tool set including memory tools. The system prompt encourages the agent to use `memory_set` for persisting findings and `memory_search` for retrieving context from prior runs. This way the agent builds up institutional knowledge across runs without needing conversation history. When creating a task, the user or agent can specify `memory_context` — a list of memory keys to pre-load into the system prompt. This gives the task agent immediate access to relevant context without searching for it.

### 4. Outbound Messaging

Channels gain a `send()` method for unprompted outbound messages.

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

**CLI implementation:** Print inline to stdout. The model can format however it wants — it's just text output. No special framing needed; the model will naturally indicate what it's reporting on.

### 5. Task Tools (`src/tools/builtin/tasks.ts`)

Tools the agent can use during normal conversations to manage background work.

| Tool | Description |
|------|-------------|
| `task_add` | Create a new task (immediately active, user-initiated) |
| `task_propose` | Propose a task (status='proposed', needs approval) |
| `task_list` | List tasks by status |
| `task_pause` | Pause a running/active task |
| `task_resume` | Resume a paused task |
| `task_cancel` | Delete a task |
| `task_run_now` | Trigger a task immediately regardless of schedule |
| `task_history` | Show recent runs for a task |

**`task_add` params:**

```json
{
  "name": "string — short identifier",
  "description": "string — what this task does",
  "prompt": "string — the agent prompt to execute each run",
  "kind": "scheduled | event | oneshot",
  "interval": "string — human-readable: '30m', '2h', '1d' (scheduled only)",
  "event_source": "file | webhook | github | command (event only)",
  "event_config": "object — source-specific config (event only)",
  "notify": "always | on_change | on_failure | never",
  "max_runs": "number | null",
  "memory_context": "string[] — memory keys to pre-load"
}
```

The channel and target are inferred from the current conversation context — if you're talking in Discord DMs, the task reports back there.

**`task_add` for event-driven example:**

```json
{
  "name": "test-on-change",
  "description": "Run tests when source files change",
  "prompt": "Source files changed: {event}. Run `bun test` and report results. If tests fail, include the failure output. If all pass, just say so briefly.",
  "kind": "event",
  "event_source": "file",
  "event_config": {
    "paths": ["src/", "test/"],
    "ignore": ["**/*.log"],
    "debounce_ms": 3000
  },
  "notify": "always"
}
```

### 6. Proposal & Approval Flow

When the agent notices an opportunity for background work, it uses `task_propose` instead of `task_add`. Proposed tasks don't run until approved.

**Approval via Discord:**

The agent sends a message like:

> **Proposed task: watch-deploy**
> I noticed you kicked off a deploy to staging. Want me to watch it and let you know when it's done?
> React :white_check_mark: to approve, :x: to dismiss.

The `DiscordChannel.onReaction` handler already exists. Wire it to the task proposals table:

```typescript
discord.onReaction(async (event) => {
  if (event.isBot) return
  const proposal = taskStore.getProposalByMessage(event.messageId)
  if (!proposal) return

  if (event.emoji === '✅') {
    taskStore.update(proposal.taskId, { status: 'active' })
    taskStore.updateProposal(proposal.id, { status: 'approved' })
    // start event sources if event-driven
    taskRunner.activateTask(proposal.taskId)
    // reply confirming
  }
  if (event.emoji === '❌') {
    taskStore.updateProposal(proposal.id, { status: 'rejected', rejectedAt: Date.now() })
    taskStore.delete(proposal.taskId)
  }
})
```

**Approval via CLI:**

Print the proposal. User types `approve <taskId>` or `reject <taskId>`.

### 7. Discovery: Finding Work (`src/tasks/discovery.ts`)

A special scheduled "meta-task" that looks for useful work. Runs at low frequency during idle time (default: every 30 minutes, only when no interactive messages for 10+ minutes).

**Discovery always uses the local model.** It's speculative work — burning API credits on "is there anything to do?" would be wasteful. The local model is more than capable of scanning git status and recent context to spot opportunities.

**How it works:**

1. Build context from: recent conversation snippets (last few messages from active sessions), current git status, active tasks list, time of day
2. Pre-load any memory context that seems relevant (let the agent call `memory_search` too)
3. Prompt the agent:
   > "Based on recent context, is there any useful background work worth proposing?
   > Consider: CI status, open PRs, pending TODOs mentioned in conversation, files being discussed, anything the user seemed to be waiting on.
   > Use memory_search to check for relevant stored context.
   > Only propose something if it's genuinely useful — don't make work for the sake of it.
   > Use task_propose for each suggestion."
4. If the agent produces `task_propose` calls → those go through the normal approval flow
5. If nothing useful → do nothing, silently

**Guard rails:**

- Max 3 proposals per discovery run (prevent spam)
- Cooldown: don't re-propose something that was rejected in the last 24h (checked via `task_proposals` table)
- Only runs when the user is "present" (had a message in the last 2 hours) — no point proposing tasks if nobody's around to approve them
- Discovery prompts have `max_turns: 5` to keep them short

## Config

New section in `egirl.toml`:

```toml
[tasks]
enabled = true
tick_interval_ms = 30000        # how often to check for due scheduled tasks
max_active_tasks = 20           # max number of active tasks at once
task_timeout_ms = 300000        # 5 min max per task run
discovery_enabled = true        # agent looks for work during idle time
discovery_interval_ms = 1800000 # 30 min between discovery runs
idle_threshold_ms = 600000      # 10 min idle before discovery kicks in
```

`max_active_tasks` is a hard limit — `task_add` and approval both check this and refuse with a clear message if hit. The user can raise or lower it based on their hardware.

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

Created in `createAppServices()` after conversation store, similar pattern. The task runner is started when the main channel starts (Discord/CLI `start()` method), not during bootstrap — it needs the outbound channel reference to deliver messages.

### Agent Loop

No changes to `AgentLoop` itself. Background tasks use the same `AgentLoop` class with a different session ID (`task:{taskId}`) and the full tool set.

### Memory

Background tasks have full access to memory tools. The system prompt encourages the agent to:
- Use `memory_set` to persist findings across runs ("CI pipeline #4521: 3 tests failed in auth module")
- Use `memory_search` to retrieve context from prior runs or related conversations
- Pre-load specific memory keys via `memory_context` field on the task

This means the agent builds up knowledge over time. A task watching CI doesn't just report "build failed" — it can correlate with previous failures, track flaky tests, notice patterns.

### Conversation Store

Task runs are persisted in `task_runs`, not in `conversations`. The task agent's conversation is ephemeral — it's rebuilt each run from the task prompt plus memory context. This keeps the conversation store clean (no phantom "conversations" from background work).

### Routing

Background tasks always start with the local model. The normal escalation logic still applies — if the local model can't handle a task, it escalates to remote. But this should be rare; background tasks are typically simple (check a status, parse some output, diff two things).

### API Server

If the API server is running, it exposes dynamic webhook routes:

```typescript
// Added to APIServer:
addWebhookRoute(path: string, handler: (req: Request) => Promise<Response>): void
removeWebhookRoute(path: string): void
```

Webhook event sources register/unregister routes through this interface. If the API server isn't running and a user tries to create a webhook-type task, the task fails to activate with: "Webhook tasks require the API server. Enable it in [channels.api]."

## Examples

### "Check CI every 30 minutes"

User says: "Watch CI for the main branch and let me know if anything breaks"

Agent calls `task_add`:
```json
{
  "name": "watch-ci-main",
  "description": "Monitor CI pipeline for main branch",
  "prompt": "Check the CI status for the main branch. Run `gh run list --branch main --limit 5` and look at the status. If any runs failed since the last check, report which ones and what failed. Store results in memory with key 'ci-main-latest' for future reference. If all passing, report nothing.",
  "kind": "scheduled",
  "interval": "30m",
  "notify": "on_change"
}
```

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

### "Run tests when I save"

User says: "Run tests whenever I change something in src/"

Agent calls `task_add`:
```json
{
  "name": "test-on-save",
  "description": "Run test suite when source files change",
  "prompt": "Source files changed. Run `bun test` and report results concisely. If all pass, just say how many passed. If any fail, include the failure output. Store a summary in memory as 'last-test-run'.",
  "kind": "event",
  "event_source": "file",
  "event_config": {
    "paths": ["src/", "test/"],
    "ignore": ["**/*.log", "node_modules/**"],
    "debounce_ms": 3000
  },
  "notify": "always"
}
```

### "Tell me when the PR gets reviewed"

```json
{
  "name": "watch-pr-42-reviews",
  "description": "Watch PR #42 for new reviews",
  "prompt": "Check PR #42 for new reviews or comments. Run `gh pr view 42 --json reviews,comments`. Compare with memory key 'pr-42-state'. If there are new reviews or comments since last check, summarize them. Update 'pr-42-state' with current state.",
  "kind": "event",
  "event_source": "github",
  "event_config": {
    "events": ["pr_review"],
    "poll_interval_ms": 120000
  },
  "notify": "on_change",
  "memory_context": ["pr-42-state"]
}
```

### "Watch for new issues"

```json
{
  "name": "new-issues",
  "description": "Alert on new GitHub issues",
  "kind": "event",
  "event_source": "github",
  "event_config": {
    "events": ["issue_opened"],
    "poll_interval_ms": 300000
  },
  "prompt": "A new issue was opened. Read it with `gh issue view {number}`. Give a brief summary — title, who opened it, key points. If it looks like a bug report, note the severity.",
  "notify": "always"
}
```

### Webhook from CI/CD

User has a CI pipeline that can POST to a webhook on completion:

```json
{
  "name": "ci-webhook",
  "description": "React to CI pipeline completions",
  "kind": "event",
  "event_source": "webhook",
  "event_config": {
    "path": "/hooks/ci",
    "secret": "whsec_abc123"
  },
  "prompt": "CI pipeline completed. The webhook payload is below. Analyze the build result — which jobs passed, which failed, what the error messages say. If there are test failures, try to identify the root cause from the logs. Report a concise summary.",
  "notify": "on_failure"
}
```

### Agent discovers work

During idle discovery, the agent notices uncommitted changes on a feature branch:

> **Proposed task: commit-reminder**
> You have 3 modified files on `feature/auth` that haven't been committed in 4 hours. Want me to remind you periodically?
> React :white_check_mark: to approve, :x: to dismiss.

### Docker container monitoring

```json
{
  "name": "docker-health",
  "description": "Watch for container health changes",
  "kind": "event",
  "event_source": "command",
  "event_config": {
    "command": "docker ps --format '{{.Names}}\\t{{.Status}}'",
    "poll_interval_ms": 15000,
    "diff_mode": "full"
  },
  "prompt": "Docker container status changed. Compare old vs new state below. Report which containers started, stopped, or changed health status. If any container is unhealthy or has restarted, flag it.",
  "notify": "on_change"
}
```

## Module Layout

```
src/tasks/
├── store.ts              # TaskStore — SQLite CRUD, scheduling queries, proposals
├── runner.ts             # TaskRunner — timer loop, agent execution, preemption
├── discovery.ts          # Discovery — idle-time work finding, always local model
├── types.ts              # Task, TaskRun, EventPayload, etc.
├── parse-interval.ts     # "30m" → 1800000, "2h" → 7200000
├── events/
│   ├── types.ts          # EventSource interface
│   ├── file-watcher.ts   # fs.watch based file monitoring
│   ├── webhook.ts        # HTTP endpoint event source
│   ├── github.ts         # GitHub polling via gh CLI
│   └── command.ts        # Shell command output diffing
└── index.ts              # createTaskStore, createTaskRunner exports
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

API server changes:
```
src/api/server.ts              # Add addWebhookRoute/removeWebhookRoute
```

## Future Work

- **Cron expressions**: Interval-based scheduling covers most cases, but cron would be nice for "every weekday at 9am". Would need a cron parsing dependency
- **Task chaining**: "When task A finishes, run task B." Can be done with a `depends_on` field. Not needed yet
- **Resource budgeting**: Token/cost caps per task per day. Currently relies on timeout + max_runs limits
- **Multi-channel delivery**: A task reports to one channel. Broadcasting isn't hard but isn't needed for single-user
- **True GitHub webhooks**: Currently GitHub events use polling. Could add a dedicated webhook receiver that parses GitHub's webhook format (X-GitHub-Event headers, signature verification). For now, the generic webhook source works if you point GitHub's webhooks at it
