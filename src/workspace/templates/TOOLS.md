# Tools

Available tools and their usage.

## File Operations

- `read_file` - Read file contents (supports line ranges)
- `write_file` - Write content to a file (creates directories)
- `edit_file` - Edit a file with exact string replacement
- `glob_files` - Find files matching a glob pattern

## System

- `execute_command` - Run shell commands
- `screenshot` - Capture a screenshot of the current display

## Git

- `git_status` - Show repository state (branch, staged/unstaged/untracked)
- `git_diff` - Show diffs (staged, unstaged, or between refs)
- `git_log` - Show commit history
- `git_commit` - Stage files and create a commit
- `git_show` - Show a specific commit's contents and diff

## Memory

- `memory_search` - Search stored memories (hybrid keyword + semantic)
- `memory_get` - Retrieve a specific memory by key
- `memory_set` - Store a new memory
- `memory_delete` - Delete a memory by key
- `memory_list` - List all stored memories

## Web

- `web_research` - Fetch a URL and return its text content

## Delegation

- `code_agent` - Delegate complex coding tasks to Claude Code
