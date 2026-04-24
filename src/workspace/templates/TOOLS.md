# Tools

Available tools and their usage. `code_agent` is the primary tool — default to delegating real coding work to it.

## Delegation (primary)

- `code_agent` — Delegate to Claude Code. Use this by default for any non-trivial coding work: multi-file edits, refactors, debugging, test writing, reading unfamiliar code.

## File Operations

- `read_file` — Read file contents (supports line ranges)
- `write_file` — Write content to a file (creates directories)
- `edit_file` — Edit a file with exact string replacement (trivial edits only; prefer `code_agent` for anything non-obvious)
- `glob_files` — Find files matching a glob pattern

## System

- `execute_command` — Run shell commands (timeout-bounded)
- `screenshot` — Capture a screenshot of the current display

## Git

- `git_status` — Show repository state (branch, staged/unstaged/untracked)
- `git_diff` — Show diffs (staged, unstaged, or between refs)
- `git_log` — Show commit history
- `git_commit` — Stage files and create a commit
- `git_show` — Show a specific commit's contents and diff

## GitHub (if `GITHUB_TOKEN` is set)

- `gh_pr_*` — View, list, create, review, comment on PRs
- `gh_issue_*` — View, list, comment, update issues
- `gh_ci_status` — Check CI status for a ref
- `gh_branch_create` — Create a branch
- `gh_release_list` — List releases

## Memory

- `memory_search` — Hybrid (keyword + semantic) search over stored memories
- `memory_recall` — Temporal recall ("what happened last week", "7 days ago")
- `memory_get` — Retrieve by exact key
- `memory_set` — Store a memory
- `memory_delete` — Remove a memory
- `memory_list` — List memories with filters

## Web

- `web_research` — Fetch a URL and return its text content
- `web_search` — Search the web (if SearxNG is configured)

## Browser (Playwright, if enabled)

- `browser_navigate`, `browser_click`, `browser_fill`, `browser_select`, `browser_check`, `browser_hover`, `browser_wait`
- `browser_snapshot` — Accessibility tree of the current page
- `browser_screenshot` — Visual screenshot
- `browser_eval` — Run JavaScript in the page
- `browser_close` — Close the browser

## Background Tasks (if enabled)

- `task_add` — Create an active scheduled or oneshot task
- `task_propose` — Propose a task for user approval
- `task_list`, `task_pause`, `task_resume`, `task_cancel`, `task_run_now`, `task_history`
