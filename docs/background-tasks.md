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

  -- What to do: either a prompt (agent decides how) or a workflow (structured steps)
  prompt TEXT NOT NULL,
  workflow TEXT,                  -- JSON: optional workflow definition (see Workflow Integration)
                                 -- If set, runs via WorkflowEngine instead of prompt-based AgentLoop

  -- Memory context: keys the agent should load before running
  memory_context TEXT,            -- JSON array of memory keys, e.g. ["deploy-config", "ci-notes"]
  memory_category TEXT,           -- category filter for proactive retrieval: 'project', 'fact', etc.

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

Polls GitHub using the native GitHub tools (`gh_pr_list`, `gh_ci_status`, `gh_issue_list`, etc. from `src/tools/builtin/github.ts`). This avoids requiring webhook infrastructure, works behind firewalls, and uses the existing `GITHUB_TOKEN` auth.

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

**Implementation**: Each event type maps to a GitHub tool from `src/tools/builtin/github.ts`:

| Event | Tool / API | Diffing |
|-------|-----------|---------|
| `push` | `gh_ci_status` (ref) or GitHub commits API | compare HEAD SHA |
| `pr_opened` | `gh_pr_list` (state=open) | compare count/latest number |
| `pr_review` | `gh_pr_view` (number, includes reviews) | compare review count |
| `pr_merged` | `gh_pr_list` (state=closed) | check merge status |
| `ci_complete` | `gh_ci_status` (ref) | compare check run conclusions |
| `ci_failed` | `gh_ci_status` (ref) | filter for `conclusion=failure` |
| `issue_opened` | `gh_issue_list` (state=open) | compare count/latest |
| `issue_comment` | `gh_issue_view` (number, includes comments) | compare comment count |
| `release` | GitHub releases API | compare tag name |

The event source calls the tools directly via the `ToolExecutor` — no LLM involved in polling. It maintains a snapshot of the last-seen state. On each poll, it compares and fires if anything changed. The snapshot is stored in the task's `last_result_hash` field.

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
1. Check if task has a workflow definition:
   - YES → run via WorkflowEngine (no LLM, see Workflow Integration below)
   - NO  → continue with prompt-based execution

2. Gather workspace context via gatherStandup() — gives the agent
   branch state, uncommitted changes, recent commits for free

3. Load memory context:
   - Pre-load task.memory_context keys (explicit context)
   - Run proactive retrieval against task.prompt with category filter
     (same as interactive — uses memory.retrieveForContext())

4. Create a fresh AgentLoop with session ID "task:{taskId}"

5. Build system prompt:
   "You are executing a background task: {task.description}
    Use memory tools to store any findings worth remembering.
    Use memory_recall for temporal context ('what happened last run').
    If you need context from previous runs, search memory."
   + standup context (appended as additionalContext)
   + pre-loaded memory context

6. If triggered by event, prepend event payload to user message:
   "[Event: {payload.summary}]\n{payload.data}\n\n{task.prompt}"

7. Run the agent with the prompt

8. Capture the final response content

9. Auto-extract memories from the task conversation (fire-and-forget,
   same as interactive — uses extractMemories() with source='auto',
   tagged with session "task:{taskId}" for traceability)

10. Hash the result, compare with last_result_hash (for on_change notification)

11. If notification criteria met → send to channel via Outbound

12. Update scheduling state (next_run_at, run_count, last_run_at)

13. If max_runs reached → set status to 'done'
```

**Memory integration**: Task prompts have access to the full tool set including all memory tools — `memory_search`, `memory_set`, `memory_recall` (temporal queries), `memory_list`, and `memory_delete`. The enhanced memory system (PR #31) provides:

- **Proactive retrieval**: Before the agent sees the prompt, relevant memories are automatically injected into context (same hybrid search used in interactive sessions, filtered by `memory_category` if set on the task)
- **Categories**: Task memories can be categorized (`project`, `fact`, `entity`, etc.) for scoped retrieval. A CI task stores findings as `category: 'project'`, a PR watcher as `category: 'entity'`
- **Temporal queries**: `memory_recall` lets the agent ask "what happened in the last hour" — useful for comparing across runs without explicit state management
- **Auto-extraction**: After each task run, the auto-extractor scans the conversation for notable facts and stores them with `source: 'auto'`. This is fire-and-forget, uses the local model, zero cost
- **Explicit context**: `memory_context` pre-loads specific keys. `memory_category` scopes proactive retrieval to relevant categories

This means the agent builds up institutional knowledge across runs. A CI watcher doesn't just report "build failed" — it can correlate with previous failures, track flaky tests, and reference decisions stored in memory.

### 4. Workflow Integration

Tasks with structured, repeatable steps can use the workflow engine (`src/workflows/engine.ts`) instead of prompt-based execution. When a task has a `workflow` field, the runner bypasses the `AgentLoop` entirely and runs the workflow via `executeWorkflow()`. This is faster, cheaper (no LLM tokens), and deterministic.

**When to use workflows vs prompts:**

| Use case | Approach | Why |
|----------|----------|-----|
| "Run tests and report" | Workflow | Deterministic steps, no LLM needed |
| "Check CI and analyze failures" | Prompt | Needs LLM to interpret failure output |
| "Pull, test, fix, push" | Workflow | Built-in `pull-test-fix` workflow |
| "Watch PR and summarize reviews" | Prompt | Needs LLM to summarize prose |
| "Git pull then run linter" | Workflow | Two sequential commands |

**Workflow task definition:**

```json
{
  "name": "auto-test-fix",
  "description": "Pull latest, run tests, auto-fix if broken",
  "kind": "scheduled",
  "interval": "1h",
  "workflow": {
    "name": "pull-test-fix",
    "params": {
      "branch": "main",
      "test_command": "bun test",
      "remote": "origin"
    }
  },
  "notify": "on_failure"
}
```

**Hybrid approach**: A task can have both a `workflow` and a `prompt`. In this case, the workflow runs first. If any step fails, the prompt-based agent takes over with the workflow results as context — it can analyze what went wrong and decide what to do. This gives you deterministic happy-path execution with LLM-powered error handling.

```json
{
  "name": "smart-test-fix",
  "description": "Run tests, use AI to diagnose failures",
  "workflow": {
    "steps": [
      { "name": "test", "tool": "execute_command", "params": { "command": "bun test" } }
    ]
  },
  "prompt": "The test run failed. Analyze the output above, identify the root cause, and suggest a fix. Store your analysis in memory as 'test-failure-{date}'."
}
```

**Ad-hoc workflow steps**: The `task_add` tool accepts inline `steps` for simple multi-command tasks. These are compiled into a workflow at creation time, avoiding the overhead of naming and registering a formal workflow.

The runner integrates with `WorkflowEngine.executeWorkflow()` and uses `{{steps.x.output}}` interpolation for passing data between steps. Retry and `continue_on_error` settings from the workflow spec apply per-step.

### 5. Outbound Messaging

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

### 6. Task Tools (`src/tools/builtin/tasks.ts`)

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
  "workflow": "string | object — named workflow ('pull-test-fix') or inline steps",
  "kind": "scheduled | event | oneshot",
  "interval": "string — human-readable: '30m', '2h', '1d' (scheduled only)",
  "event_source": "file | webhook | github | command (event only)",
  "event_config": "object — source-specific config (event only)",
  "notify": "always | on_change | on_failure | never",
  "max_runs": "number | null",
  "memory_context": "string[] — memory keys to pre-load",
  "memory_category": "string — category filter for proactive retrieval"
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

### 7. Proposal & Approval Flow

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

### 8. Discovery: Finding Work (`src/tasks/discovery.ts`)

A special scheduled "meta-task" that looks for useful work. Runs at low frequency during idle time (default: every 30 minutes, only when no interactive messages for 10+ minutes).

**Discovery always uses the local model.** It's speculative work — burning API credits on "is there anything to do?" would be wasteful. The local model is more than capable of scanning git status and recent context to spot opportunities.

**How it works:**

1. Gather workspace context via `gatherStandup()` — branch state, uncommitted files, recent commits
2. Run proactive memory retrieval against a broad query ("recent project context, pending work, open items")
3. Build context: standup + recalled memories + active tasks list + time of day
4. Prompt the agent (local model, full tool access):
   > "Based on the workspace and memory context below, is there any useful background work worth proposing?
   > Consider: CI status, open PRs, pending TODOs, files being discussed, anything the user seemed to be waiting on.
   > Use memory_search and memory_recall to check for relevant context.
   > Only propose something if it's genuinely useful — don't make work for the sake of it.
   > Use task_propose for each suggestion."
5. If the agent produces `task_propose` calls → those go through the normal approval flow
6. If nothing useful → do nothing, silently

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

No changes to `AgentLoop` itself. Prompt-based background tasks use the same `AgentLoop` class with a different session ID (`task:{taskId}`), full tool set, and `additionalContext` set to standup output. Workflow-based tasks bypass `AgentLoop` entirely and use `executeWorkflow()` from `src/workflows/engine.ts`.

### Workflow Engine

Tasks with a `workflow` field run through the existing `WorkflowEngine` (`src/workflows/engine.ts`). This means:
- No LLM tokens consumed for deterministic steps
- Step interpolation (`{{steps.test.output}}`) passes data between steps
- Conditional execution (`if: "test.failed"`) handles branching
- Per-step retry logic handles transient failures
- Built-in workflows (`pull-test-fix`, `test-fix`, `commit-push`) are available immediately
- The `run_workflow` tool is also available to prompt-based tasks, so the agent can decide to use a workflow mid-execution

### Memory

The enhanced memory system (PR #31) integrates deeply with background tasks:

- **Proactive retrieval**: Before each task run, `retrieveForContext()` injects relevant memories based on the task prompt. Filtered by `memory_category` if set on the task
- **Auto-extraction**: After each task run, `extractMemories()` scans the conversation for notable facts (fire-and-forget, local model). Stored with `source: 'auto'`, `session_id: 'task:{taskId}'`
- **Temporal queries**: `memory_recall` lets the agent query by time range — "what happened in the last hour" is natural for comparing across runs
- **Categories**: Task memories should use appropriate categories (`project` for CI findings, `entity` for PR/issue state, `fact` for concrete results). This scopes retrieval so a CI task doesn't get flooded with unrelated conversation memories
- **Pre-loaded keys**: `memory_context` field explicitly loads specific keys into system prompt before execution

### Standup Context

Background tasks get workspace context via `gatherStandup()` from `src/standup/gather.ts`. This is injected as `additionalContext` on the `AgentLoop`, same as interactive sessions. The agent immediately knows: current branch, ahead/behind status, uncommitted files, recent commits, stash count. No git commands needed to orient itself.

### Conversation Store

Task runs are persisted in `task_runs`, not in `conversations`. The task agent's conversation is ephemeral — it's rebuilt each run from the task prompt plus memory context. This keeps the conversation store clean (no phantom "conversations" from background work).

### GitHub Tools

The GitHub event source (`src/tasks/events/github.ts`) uses the native GitHub tools from `src/tools/builtin/github.ts` for polling — `gh_pr_list`, `gh_ci_status`, `gh_issue_list`, `gh_pr_view`, etc. These tools call the GitHub API directly via `fetch()` with token auth, no `gh` CLI dependency for polling. The event source calls tools through `ToolExecutor` directly (no LLM), compares output hashes, and fires events on change.

Prompt-based task agents also have access to the full GitHub tool set, so they can create PRs, comment on issues, check CI, and create branches as part of task execution.

### Routing

Background tasks always start with the local model. The normal escalation logic still applies — if the local model can't handle a task, it escalates to remote. But this should be rare; background tasks are typically simple (check a status, parse some output, diff two things).

### Notification Filtering

For Discord passive channels, the batch evaluator (`src/channels/discord/batch-evaluator.ts`) provides a relevance scoring pattern. Background task notifications can optionally use the same approach — before sending a notification to a passive channel, run `evaluateRelevance()` to check if the result is actually worth interrupting for. This prevents noisy tasks from spamming channels. Active channels (DMs, direct mentions) skip this filter — if you asked for a task, you get the notification.

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
  "prompt": "Check CI status for main using gh_ci_status. If any checks failed since the last run, report which ones and what failed. Use memory_recall to compare with previous results. Store findings in memory with key 'ci-main-latest' (category: project). If all passing, report nothing.",
  "kind": "scheduled",
  "interval": "30m",
  "notify": "on_change",
  "memory_category": "project"
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
  "prompt": "Check PR #42 for new reviews or comments using gh_pr_view. Compare with memory key 'pr-42-state'. If there are new reviews or comments since last check, summarize them. Update 'pr-42-state' with current state.",
  "kind": "event",
  "event_source": "github",
  "event_config": {
    "events": ["pr_review"],
    "poll_interval_ms": 120000
  },
  "notify": "on_change",
  "memory_context": ["pr-42-state"],
  "memory_category": "entity"
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
  "prompt": "A new issue was opened. Use gh_issue_view to read it. Give a brief summary — title, who opened it, key points. If it looks like a bug report, note the severity. Store a summary in memory as 'issue-{number}-summary' (category: entity).",
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

### "Pull and test every hour" (workflow-based, no LLM)

```json
{
  "name": "hourly-test",
  "description": "Pull latest and run tests — no AI needed",
  "kind": "scheduled",
  "interval": "1h",
  "workflow": {
    "name": "pull-test-fix",
    "params": {
      "branch": "main",
      "test_command": "bun test",
      "remote": "origin"
    }
  },
  "notify": "on_failure"
}
```

Zero LLM tokens per run. The workflow engine pulls, tests, and only notifies if something breaks. If the built-in `pull-test-fix` workflow includes an auto-fix step that fails, the notification includes the workflow step output.

### "Smart test watcher" (hybrid: workflow + prompt fallback)

```json
{
  "name": "smart-test",
  "description": "Run tests on file change, AI diagnoses failures",
  "kind": "event",
  "event_source": "file",
  "event_config": {
    "paths": ["src/"],
    "debounce_ms": 5000
  },
  "workflow": {
    "steps": [
      { "name": "test", "tool": "execute_command", "params": { "command": "bun test" } }
    ]
  },
  "prompt": "Tests failed. Analyze the output above. Identify the root cause, check if this is a known flaky test (use memory_search for 'flaky'), and suggest a fix. Store analysis as 'test-failure-latest' (category: project).",
  "notify": "on_failure",
  "memory_category": "project"
}
```

Workflow runs first (fast, free). If tests pass, done — no LLM. If tests fail, the prompt-based agent kicks in to analyze and diagnose.

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
- **Task chaining**: "When task A finishes, run task B." Workflow engine already supports step chaining within a task. Cross-task chaining (task A triggers task B) would need a `depends_on` field. Not needed yet
- **Resource budgeting**: Token/cost caps per task per day. Currently relies on timeout + max_runs limits. Could use the `StatsTracker` to track per-task token usage and enforce budgets
- **Multi-channel delivery**: A task reports to one channel. Broadcasting isn't hard but isn't needed for single-user
- **Dedicated GitHub webhook receiver**: Currently GitHub events use polling via the native GitHub tools. The generic webhook event source works for receiving GitHub webhooks too, but a dedicated receiver could parse `X-GitHub-Event` headers and verify signatures with the GitHub HMAC scheme specifically
