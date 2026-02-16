# Built-in Tools Reference

egirl ships with 48 built-in tools across 8 categories that the agent can invoke during conversations. Tools are registered in the `ToolExecutor` at startup and described in the system prompt so the model knows how to use them.

| Category | Count | Tools |
|----------|-------|-------|
| File ops | 4 | `read_file`, `write_file`, `edit_file`, `glob_files` |
| Commands | 1 | `execute_command` |
| Memory | 5 | `memory_search`, `memory_get`, `memory_set`, `memory_delete`, `memory_list` |
| Git | 5 | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_show` |
| GitHub | 11 | `gh_pr_list`, `gh_pr_view`, `gh_pr_create`, `gh_pr_review`, `gh_pr_comment`, `gh_issue_list`, `gh_issue_view`, `gh_issue_comment`, `gh_issue_update`, `gh_ci_status`, `gh_branch_create` |
| Browser | 11 | `browser_navigate`, `browser_click`, `browser_fill`, `browser_snapshot`, `browser_screenshot`, `browser_select`, `browser_check`, `browser_hover`, `browser_wait`, `browser_eval`, `browser_close` |
| Tasks | 8 | `task_add`, `task_propose`, `task_list`, `task_pause`, `task_resume`, `task_cancel`, `task_run_now`, `task_history` |
| Other | 3 | `screenshot`, `web_research`, `code_agent` |

## Tool Architecture

```
Agent Loop
    │
    ▼
ToolExecutor.executeAll(toolCalls, cwd)
    │
    ├─→ Tool 1: execute(params, cwd) → ToolResult
    ├─→ Tool 2: execute(params, cwd) → ToolResult
    └─→ Tool N: execute(params, cwd) → ToolResult
```

All tool calls within a single response are executed concurrently via `Promise.all`. Each tool receives its parameters as a `Record<string, unknown>` and the current working directory.

### ToolResult

Every tool returns:

```typescript
interface ToolResult {
  success: boolean
  output: string
  isImage?: boolean              // true for screenshot results
  suggest_escalation?: boolean   // hint to switch to remote provider
  escalation_reason?: string     // why escalation is suggested
}
```

Errors are returned as `{ success: false, output: "..." }` — tools never throw.

---

## read_file

Read the contents of a file. Supports reading specific line ranges.

**Source:** `src/tools/builtin/read.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path (relative to cwd or absolute) |
| `start_line` | number | No | Starting line number (1-indexed, inclusive) |
| `end_line` | number | No | Ending line number (1-indexed, inclusive) |

**Behavior:**
- Relative paths are resolved against the working directory
- When line range is specified, output includes line numbers: `42: line content`
- Returns full file content when no range is specified

**Example:**
```json
{"name": "read_file", "arguments": {"path": "src/index.ts", "start_line": 1, "end_line": 20}}
```

---

## write_file

Write content to a file. Creates the file and parent directories if they don't exist.

**Source:** `src/tools/builtin/write.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path (relative to cwd or absolute) |
| `content` | string | Yes | Content to write |
| `create_directories` | boolean | No | Create parent directories (default: `true`) |

**Behavior:**
- Overwrites the file if it already exists
- Creates parent directories by default (`mkdir -p`)
- Returns character count on success

**Example:**
```json
{"name": "write_file", "arguments": {"path": "output.txt", "content": "Hello, world!"}}
```

---

## edit_file

Edit a file by replacing an exact text match with new text.

**Source:** `src/tools/builtin/edit.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path (relative to cwd or absolute) |
| `old_text` | string | Yes | Exact text to find (must match exactly, including whitespace) |
| `new_text` | string | Yes | Replacement text |

**Behavior:**
- The `old_text` must match exactly — no regex or fuzzy matching
- If the text is not found, returns `success: false` and sets `suggest_escalation: true`
- If multiple occurrences are found, returns an error asking for more context to make the match unique
- Only replaces the first occurrence

**Escalation:** This tool suggests escalation when the target text isn't found, as this may indicate the model has incorrect context about the file's contents.

**Example:**
```json
{"name": "edit_file", "arguments": {"path": "src/config.ts", "old_text": "const PORT = 3000", "new_text": "const PORT = 8080"}}
```

---

## execute_command

Run a shell command and return its output.

**Source:** `src/tools/builtin/exec.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `working_dir` | string | No | Working directory (defaults to cwd) |
| `timeout` | number | No | Timeout in milliseconds (default: 30000) |

**Behavior:**
- Runs via `child_process.spawn` with `shell: true`
- Inherits the current environment variables
- stdout and stderr are captured separately
- On timeout, the process is killed with `SIGTERM` and partial output is returned
- Exit code 0 = success, anything else = failure

**Example:**
```json
{"name": "execute_command", "arguments": {"command": "git status", "timeout": 10000}}
```

---

## glob_files

Find files matching a glob pattern.

**Source:** `src/tools/builtin/glob.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Glob pattern (e.g., `**/*.ts`, `src/**/*.js`) |
| `dir` | string | No | Directory to search in (defaults to cwd) |

**Behavior:**
- Uses `Bun.Glob` for pattern matching
- Only returns files (not directories)
- Results are newline-separated file paths relative to the search directory

**Example:**
```json
{"name": "glob_files", "arguments": {"pattern": "**/*.test.ts"}}
```

---

## memory_search

Search stored memories using hybrid search (keyword + semantic similarity).

**Source:** `src/tools/builtin/memory.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query — keywords, questions, or natural language |
| `limit` | number | No | Maximum results (default: 10) |

**Behavior:**
- Uses hybrid search by default (30% FTS weight, 70% vector weight)
- Returns formatted results with key, relevance score, and content preview
- If no memories match, returns "No memories found"
- Requires the memory system to be initialized (embeddings configured)

**Example:**
```json
{"name": "memory_search", "arguments": {"query": "user's preferred editor", "limit": 5}}
```

---

## memory_get

Retrieve a specific memory by its exact key.

**Source:** `src/tools/builtin/memory.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Exact memory key |

**Behavior:**
- Returns the full memory content for the given key
- If the memory has an associated image, includes the image path
- Returns `success: false` if the key doesn't exist

**Example:**
```json
{"name": "memory_get", "arguments": {"key": "user_preferred_editor"}}
```

---

## memory_set

Store a new memory or update an existing one.

**Source:** `src/tools/builtin/memory.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Unique identifier (e.g., `"user_name"`, `"project_goal"`) |
| `value` | string | Yes | Content to remember |

**Behavior:**
- Generates an embedding vector automatically if embeddings are configured
- Overwrites existing memory with the same key
- Logs the operation to the daily log file
- Key naming convention: use descriptive, hierarchical names like `"meeting_2024-01-15"` or `"preference_editor"`

**Example:**
```json
{"name": "memory_set", "arguments": {"key": "user_timezone", "value": "UTC+1 (Berlin)"}}
```

---

## memory_delete

Delete a memory by its exact key. Use this to remove outdated or incorrect information.

**Source:** `src/tools/builtin/memory.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Exact memory key to delete |

**Behavior:**
- Deletes the memory entry and its embedding vector
- Returns `success: false` if the key doesn't exist
- Requires the memory system to be initialized

**Example:**
```json
{"name": "memory_delete", "arguments": {"key": "old_project_goal"}}
```

---

## memory_list

List all stored memories with their keys, content types, and previews.

**Source:** `src/tools/builtin/memory.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Maximum number of memories to list (default: 50) |

**Behavior:**
- Returns all stored memories with key, type, and content preview
- Useful for browsing what has been remembered
- Requires the memory system to be initialized

**Example:**
```json
{"name": "memory_list", "arguments": {"limit": 20}}
```

---

## screenshot

Capture a screenshot of the current display.

**Source:** `src/tools/builtin/screenshot.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `display` | string | No | Display to capture (default: primary) |
| `region` | object | No | Region to capture: `{ x, y, width, height }` |

**Behavior:**
- Tries screenshot tools in order: `grim` (Wayland) → `scrot` (X11) → `maim` (X11) → `gnome-screenshot`
- Returns base64-encoded PNG as a data URL
- Supports region capture for `grim`, `scrot`, and `maim`
- Cleans up temporary files after capture
- Requires a display server and at least one screenshot tool installed

**Example:**
```json
{"name": "screenshot", "arguments": {"region": {"x": 0, "y": 0, "width": 1920, "height": 1080}}}
```

---

## web_research

Fetch a URL and return its text content. Useful for reading web pages, documentation, and API responses.

**Source:** `src/tools/builtin/web-research.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | The URL to fetch (must start with `http://` or `https://`) |
| `timeout` | number | No | Request timeout in milliseconds (default: 15000) |

**Behavior:**
- Validates that the URL starts with `http://` or `https://`
- Follows redirects automatically
- HTML responses are stripped of tags and converted to plain text (scripts, styles removed)
- JSON responses are pretty-printed for readability
- Content exceeding 50,000 characters is truncated
- On timeout, returns an error with the elapsed time

**Example:**
```json
{"name": "web_research", "arguments": {"url": "https://example.com/api/docs", "timeout": 10000}}
```

---

## git_status

Show the current git repository state: branch name, staged changes, unstaged changes, and untracked files.

**Source:** `src/tools/builtin/git.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo_dir` | string | No | Repository directory (defaults to cwd) |

**Behavior:**
- Shows current branch name
- Categorizes changes into staged, modified (unstaged), and untracked
- Returns "clean working tree" when there are no changes
- Detects if the directory is not a git repository

**Example:**
```json
{"name": "git_status", "arguments": {}}
```

---

## git_diff

Show git diff output. Can show staged changes, unstaged changes, or diff between references.

**Source:** `src/tools/builtin/git.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `staged` | boolean | No | Show staged (cached) changes instead of unstaged (default: false) |
| `files` | string[] | No | Limit diff to specific file paths |
| `ref` | string | No | Diff against a specific ref (branch, tag, commit hash). Overrides staged flag. |
| `context_lines` | number | No | Number of context lines around changes (default: 3) |
| `repo_dir` | string | No | Repository directory (defaults to cwd) |

**Behavior:**
- Includes both stat summary and patch output
- Large diffs are truncated to protect context window (20,000 char limit)
- Returns "No differences found" when clean

**Example:**
```json
{"name": "git_diff", "arguments": {"staged": true}}
```

---

## git_log

Show recent commit history in a compact format.

**Source:** `src/tools/builtin/git.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `count` | number | No | Number of commits to show (default: 10, max: 50) |
| `ref` | string | No | Branch, tag, or commit to show history for (default: HEAD) |
| `file` | string | No | Show only commits that touch this file path |
| `oneline` | boolean | No | Ultra-compact one-line-per-commit format (default: false) |
| `repo_dir` | string | No | Repository directory (defaults to cwd) |

**Behavior:**
- Default format: hash, author, date, message
- Oneline format: hash and message only
- Supports filtering by file path

**Example:**
```json
{"name": "git_log", "arguments": {"count": 5, "oneline": true}}
```

---

## git_commit

Stage files and create a git commit. Does NOT push.

**Source:** `src/tools/builtin/git.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | Yes | Commit message |
| `files` | string[] | No | Files to stage before committing. Use `["."]` to stage everything. |
| `repo_dir` | string | No | Repository directory (defaults to cwd) |

**Behavior:**
- Stages specified files before committing (if provided)
- Checks that there are staged changes before committing
- Returns the new commit hash and message on success
- Does not push to any remote

**Example:**
```json
{"name": "git_commit", "arguments": {"message": "Fix routing logic", "files": ["src/router.ts"]}}
```

---

## git_show

Show the contents of a specific commit: message, author, date, and diff.

**Source:** `src/tools/builtin/git.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ref` | string | No | Commit hash, branch, or tag to show (default: HEAD) |
| `file` | string | No | Show only changes to this file in the commit |
| `repo_dir` | string | No | Repository directory (defaults to cwd) |

**Behavior:**
- Shows full commit metadata (hash, author, date, message) plus stat and patch
- Large diffs are truncated to protect context window
- Supports filtering to a specific file

**Example:**
```json
{"name": "git_show", "arguments": {"ref": "HEAD~1"}}
```

---

## code_agent

Delegate a coding task to an autonomous code agent (Claude Code) via the `@anthropic-ai/claude-agent-sdk`.

**Source:** `src/tools/builtin/code-agent.ts`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | Yes | A clear description of the coding task to perform |
| `working_dir` | string | No | Working directory for the task (defaults to configured workspace) |

**Behavior:**
- Launches a Claude Code session using the Agent SDK's `query()` function
- The code agent has full filesystem and command execution access
- Permission mode, model, and max turns are configured in `[channels.claude_code]` in `egirl.toml`
- Default timeout is 5 minutes; the session is aborted if exceeded
- Returns the agent's final result with metadata (turns, cost, duration, session ID)
- If the agent completes without producing a result, returns `success: false`

**Example:**
```json
{"name": "code_agent", "arguments": {"task": "Refactor the routing module to extract heuristics into a separate file"}}
```

---

## GitHub Tools

GitHub tools are created via `createGitHubTools(config)` in `src/tools/builtin/github.ts`. They require a `GITHUB_TOKEN` environment variable. Repository owner and repo are auto-detected from the git remote when not specified.

### gh_pr_list

List pull requests for a GitHub repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `state` | string | No | Filter by PR state: `open`, `closed`, `all` (default: `open`) |
| `head` | string | No | Filter by head branch |
| `base` | string | No | Filter by base branch |
| `limit` | number | No | Max results (default: 10, max: 30) |
| `owner` | string | No | Repository owner (auto-detected from git remote) |
| `repo` | string | No | Repository name (auto-detected from git remote) |

### gh_pr_view

View detailed PR information: title, description, reviews, check status, and file changes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | PR number |
| `owner` | string | No | Repository owner |
| `repo` | string | No | Repository name |

### gh_pr_create

Create a new pull request. The head branch must already be pushed to the remote.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | PR title |
| `head` | string | Yes | Head branch name |
| `base` | string | No | Base branch (default: `main`) |
| `body` | string | No | PR description |
| `draft` | boolean | No | Create as draft (default: `false`) |
| `owner` | string | No | Repository owner |
| `repo` | string | No | Repository name |

### gh_pr_review

Submit a review on a pull request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | PR number |
| `event` | string | Yes | Review action: `APPROVE`, `REQUEST_CHANGES`, `COMMENT` |
| `body` | string | No | Review comment (required for `REQUEST_CHANGES` and `COMMENT`) |
| `owner` | string | No | Repository owner |
| `repo` | string | No | Repository name |

### gh_pr_comment

Add a comment to a pull request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | PR number |
| `body` | string | Yes | Comment text |
| `owner` | string | No | Repository owner |
| `repo` | string | No | Repository name |

### gh_issue_list

List issues for a GitHub repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `state` | string | No | Filter: `open`, `closed`, `all` (default: `open`) |
| `labels` | string | No | Comma-separated label names |
| `assignee` | string | No | Filter by assignee username |
| `sort` | string | No | Sort by: `created`, `updated`, `comments` (default: `updated`) |
| `limit` | number | No | Max results (default: 10, max: 30) |
| `owner` | string | No | Repository owner |
| `repo` | string | No | Repository name |

### gh_issue_view

View detailed issue information including body and recent comments.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | Issue number |
| `owner` | string | No | Repository owner |
| `repo` | string | No | Repository name |

### gh_issue_comment

Add a comment to a GitHub issue.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | Issue number |
| `body` | string | Yes | Comment text |
| `owner` | string | No | Repository owner |
| `repo` | string | No | Repository name |

### gh_issue_update

Update a GitHub issue: change state, labels, assignees, or title.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | Issue number |
| `state` | string | No | Set state: `open`, `closed` |
| `title` | string | No | New title |
| `labels` | string[] | No | Replace all labels |
| `assignees` | string[] | No | Replace all assignees |
| `owner` | string | No | Repository owner |
| `repo` | string | No | Repository name |

### gh_ci_status

Check CI/workflow status for a git ref (branch, tag, or commit SHA).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ref` | string | No | Git ref to check (default: HEAD branch) |
| `owner` | string | No | Repository owner |
| `repo` | string | No | Repository name |

### gh_branch_create

Create a new branch on the GitHub remote.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `branch` | string | Yes | Name for the new branch |
| `from` | string | No | Source ref to branch from (default: `main`) |
| `owner` | string | No | Repository owner |
| `repo` | string | No | Repository name |

---

## Browser Tools

Browser tools are created via `createBrowserTools(manager)` in `src/tools/builtin/browser.ts`. They use Playwright for browser automation with accessibility-based element targeting. Requires `playwright` to be installed (`bunx playwright install`).

**Targeting format:** Elements are targeted using `"role/Name"` for ARIA roles (e.g., `"button/Submit"`, `"link/Home"`), `"text:value"` for text content, `"label:value"` for form labels, `"placeholder:value"`, `"testid:value"`, `"title:value"`, or `"css:selector"` as an escape hatch.

### browser_navigate

Navigate the browser to a URL. Returns a text snapshot of the page content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to navigate to (must start with `http://` or `https://`) |

### browser_click

Click an element on the page using accessibility targeting.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | string | Yes | Element target ref (e.g., `"button/Submit"`, `"link/Home"`) |

### browser_fill

Fill a form field using accessibility targeting.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | string | Yes | Element target ref (e.g., `"textbox/Email"`, `"label:Password"`) |
| `value` | string | Yes | Text to fill into the field |

### browser_snapshot

Get a text snapshot of the current page content.

*No parameters.*

### browser_screenshot

Take a screenshot of the current browser page for visual analysis.

*No parameters.*

### browser_select

Select an option from a dropdown/select element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | string | Yes | Element target ref (e.g., `"combobox/Country"`) |
| `value` | string | Yes | Option value or label to select |

### browser_check

Check or uncheck a checkbox element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | string | Yes | Element target ref (e.g., `"checkbox/Remember me"`) |
| `checked` | boolean | No | Check (`true`) or uncheck (`false`) (default: `true`) |

### browser_hover

Hover over an element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | string | Yes | Element target ref (e.g., `"button/Menu"`) |

### browser_wait

Wait for an element to become visible on the page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | string | Yes | Element target ref to wait for |
| `timeout` | number | No | Max wait time in ms (default: 30000) |

### browser_eval

Evaluate a JavaScript expression in the browser page context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `expression` | string | Yes | JavaScript expression to evaluate |

### browser_close

Close the browser. It relaunches automatically on the next browser action.

*No parameters.*

---

## Task Tools

Task tools are created via `createTaskTools(store, runner, maxActiveTasks, getContext)` in `src/tools/builtin/tasks.ts`. They manage the [background task framework](background-tasks.md).

### task_add

Create a new background task that activates immediately.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Short identifier (e.g., `"watch-ci-main"`) |
| `description` | string | Yes | What this task does |
| `prompt` | string | Yes | Agent prompt to execute each run |
| `kind` | string | Yes | Task type: `scheduled`, `event`, `oneshot` |
| `interval` | string | No | Run interval: `"30m"`, `"2h"`, `"1d"` (scheduled only) |
| `cron` | string | No | Cron expression or time: `"0 9 * * MON-FRI"`, `"09:00"` (scheduled only) |
| `business_hours` | string | No | Restrict runs: `"9-17 Mon-Fri"`, `"business"` |
| `depends_on` | string | No | Task ID — runs after that task completes |
| `event_source` | string | No | Event source: `file`, `webhook`, `github`, `command` (event only) |
| `event_config` | object | No | Source-specific config (event only) |
| `workflow` | object | No | Workflow definition for deterministic execution |
| `notify` | string | No | Notification: `always`, `on_change`, `on_failure`, `never` (default: `on_change`) |
| `max_runs` | number | No | Max runs (`null` = unlimited) |
| `memory_context` | string[] | No | Memory keys to pre-load |
| `memory_category` | string | No | Category filter for proactive retrieval |

### task_propose

Propose a task for user approval. Stays inactive until approved via reaction (Discord) or command (CLI).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Short identifier |
| `description` | string | Yes | What this task does |
| `prompt` | string | Yes | Agent prompt |
| `kind` | string | Yes | Task type: `scheduled`, `event`, `oneshot` |
| `reason` | string | Yes | Why this task would be useful |
| `interval` | string | No | Run interval (scheduled only) |
| `cron` | string | No | Cron expression (scheduled only) |
| `event_source` | string | No | Event source (event only) |
| `event_config` | object | No | Source-specific config (event only) |
| `notify` | string | No | Notification mode (default: `on_change`) |
| `max_runs` | number | No | Max runs |

### task_list

List background tasks, optionally filtered by status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter: `active`, `paused`, `proposed`, `done`, `failed` |

### task_pause

Pause an active background task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Task ID to pause |

### task_resume

Resume a paused background task. Clears failure tracking.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Task ID to resume |

### task_cancel

Delete a background task permanently.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Task ID to cancel |

### task_run_now

Trigger a task to run immediately, regardless of schedule.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Task ID to run |

### task_history

Show recent run history for a task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Task ID |
| `limit` | number | No | Number of runs to show (default: 5) |

---

## Adding Custom Tools

Tools implement the `Tool` interface from `src/tools/types.ts`:

```typescript
interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string; [key: string]: unknown }>
    required?: string[]
  }
}

interface Tool {
  definition: ToolDefinition
  execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult>
}
```

Register tools with the executor:

```typescript
const executor = createToolExecutor()
executor.register(myCustomTool)
```

Tool definitions are included in the system prompt and formatted according to the Qwen3 tool calling spec (see [tool-format.md](tool-format.md)).
