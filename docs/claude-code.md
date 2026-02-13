# Claude Code Integration

egirl includes a bridge to Claude Code (Anthropic's agentic coding tool) that uses the local model as a supervisor. This enables running Claude Code tasks while using your local model to handle permission decisions and answer clarifying questions.

## Overview

```
User
  │
  ▼
egirl (Claude Code channel)
  │
  ├──→ Claude Code (via @anthropic-ai/claude-agent-sdk)
  │       │
  │       ├── Tool permission request ──→ Local model decides (ALLOW/DENY)
  │       ├── AskUserQuestion ──→ Local model answers
  │       └── Work output ──→ Displayed to user
  │
  └──→ Local LLM (llama.cpp)
          └── Makes permission/question decisions
```

The local model acts as a security supervisor, deciding whether to allow Claude Code's tool requests and answering its clarifying questions — all without human intervention.

## Usage

### Interactive Mode

```bash
bun run start claude-code
# or
bun run start cc
```

Opens an interactive prompt where you type tasks for Claude Code to execute. The local model handles all permission and question prompts automatically.

### Single Task Mode

```bash
bun run start cc -m "fix the failing tests in src/routing/"
```

Runs a single task and exits with the result, turn count, cost, and duration.

### Resume a Session

```bash
bun run start cc --resume <session-id>
bun run start cc --resume <session-id> -m "now run the tests"
```

Resumes a previous Claude Code session, optionally with a follow-up prompt.

## How Permission Handling Works

When Claude Code wants to use a tool (read a file, run a command, edit code), it sends a permission request. The local model evaluates whether the request is safe:

### Permission Decision Flow

```
Claude Code: "I want to run: npm test"
                    │
                    ▼
        ┌───────────────────────┐
        │ Local Model Evaluates │
        │                       │
        │ System: You are a     │
        │ security supervisor.  │
        │ ALLOW or DENY?        │
        │                       │
        │ Context:              │
        │ - Original task       │
        │ - Recent activity     │
        │ - Tool + input        │
        └───────────┬───────────┘
                    │
              ┌─────┴─────┐
              │           │
         ALLOW: safe   DENY: risky
         for task      or destructive
```

### Default Guidelines

The local model follows these rules:

**ALLOW:**
- Reading files
- Safe commands: `ls`, `cat`, `grep`, `git status`, `npm test`, etc.
- Writing/editing files that are part of the task
- When in doubt — Claude Code is generally safe

**DENY:**
- Destructive commands: `rm -rf`, `drop database`, etc. (unless explicitly requested)
- Accessing sensitive files: `/etc/passwd`, `.env` with secrets, SSH keys (unless needed)
- Network requests to unknown hosts (unless part of the task)

### Question Handling

When Claude Code uses `AskUserQuestion` to ask for clarification, the local model picks the most practical option:

```
Claude Code: "Which approach should I take?"
Options:
  1. Refactor existing code
  2. Write from scratch
  3. Use a library

Local Model → Picks option based on original task context
```

The local model receives the original task description and all available options, then selects the best fit.

## Configuration

In `egirl.toml`:

```toml
[channels.claude_code]
permission_mode = "bypassPermissions"   # or "default"
model = "claude-sonnet-4-20250514"      # optional model override
working_dir = "/home/user/projects"     # working directory for operations
max_turns = 50                          # optional turn limit
```

### Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Claude Code asks permission for each tool; local model decides |
| `acceptEdits` | Auto-approve file edits, ask about everything else |
| `bypassPermissions` | Skip all permission prompts entirely |
| `plan` | Claude Code creates a plan before executing |

When `permission_mode` is `"default"`, every tool call goes through the local model for approval. This provides the most control but adds latency for each tool call.

When `permission_mode` is `"bypassPermissions"`, Claude Code runs without any permission checks — fastest but least controlled.

## TaskResult

Each Claude Code task returns:

```typescript
interface TaskResult {
  result: string      // Final text output from Claude Code
  sessionId: string   // Session ID (for resuming later)
  turns: number       // Number of agentic turns
  costUsd: number     // API cost in USD
  durationMs: number  // Wall clock time
}
```

## Output Format

During execution, the channel emits prefixed log lines:

```
[cc] Starting query with permission mode: bypassPermissions
[cc] Session a1b2c3d4... | Model: claude-sonnet-4-20250514
[cc:permission] Bash: npm test
[local] Approved: Safe testing command relevant to the task
[cc:read] src/routing/model-router.ts
[cc] I found the issue in the routing logic...
[cc:edit] src/routing/model-router.ts
[local] Approved: Edit is part of fixing the tests
```

Prefixes:
- `[cc]` — Claude Code general output
- `[cc:permission]` — Tool permission request
- `[cc:question]` — Clarifying question from Claude Code
- `[cc:bash]`, `[cc:read]`, `[cc:edit]`, etc. — Specific tool usage
- `[local]` — Local model's response to a permission/question

## Requirements

- `ANTHROPIC_API_KEY` in `.env` (Claude Code requires Anthropic API access)
- `@anthropic-ai/claude-agent-sdk` package (included in dependencies)
- A running local llama.cpp server (for permission decisions in `default` mode)
