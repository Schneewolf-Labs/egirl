# Code Agent Integration

`code_agent` is egirl's primary delegation tool for real engineering work. The local model stays in charge of planning and supervision, then hands coding tasks to a configured backend that can inspect the repository, edit files, run commands, and iterate.

Supported backends:

- **Claude Code** through `@anthropic-ai/claude-agent-sdk`
- **Codex** through the local interactive `codex` CLI in a PTY
- **OpenCode** through a locally-spawned `opencode serve` HTTP server
- **Any ACP agent** (Gemini CLI, Claude Code or Codex through adapters, opencode) through the Agent Client Protocol — see [acp.md](acp.md)

## Mental Model

```
User
  |
  v
egirl local model
  |
  | calls code_agent when coding work is too large or risky to hand-edit
  v
Configured code agent backend
  |
  |- reads and edits the project
  |- runs commands and tests
  |- asks for permission or clarification when needed
  v
Result returned to egirl
```

The code agent is a tool, not a second chat provider. egirl still uses the configured local llama.cpp model for conversation, planning, memory, safety decisions, and Codex interactive prompt decisions.

## Enabling the Tool

Enable `code_agent` in `egirl.toml`:

```toml
[tools]
code_agent = true
```

Configure the backend under `[channels.code_agent]`:

```toml
[channels.code_agent]
provider = "claude"          # "claude", "codex", or "opencode"
permission_mode = "default"  # or "bypassPermissions"
working_dir = "~/projects/myrepo"
# model = "sonnet"
# max_turns = 30             # Claude backend only
```

If `[channels.code_agent]` is omitted, egirl falls back to `[channels.claude_code]` for backward compatibility and uses the Claude backend.

## Claude Backend

Claude Code uses the Agent SDK. It can run in the same permission modes as the direct `claude-code` / `cc` bridge command:

```toml
[channels.code_agent]
provider = "claude"
permission_mode = "bypassPermissions"
model = "sonnet"
working_dir = "~/projects/myrepo"
max_turns = 30
```

Requirements:

- Run `claude auth login` once for Claude Code subscription auth.
- Keep `@anthropic-ai/claude-agent-sdk` installed through `bun install`.
- Use `permission_mode = "default"` if you want the local model to answer Claude Code permission and clarification prompts.

`[channels.claude_code]` still configures only the direct interactive `bun run start claude-code` / `bun run start cc` channel. Prefer `[channels.code_agent]` for tool behavior.

## Codex Backend

Codex uses the installed CLI's `app-server` over stdio with subscription authentication. Structured turn events determine completion, and command/file approvals go through the local permission supervisor. Missing supervisors, unsupported questions, and supervisor errors stop the task instead of silently approving. No terminal scraping is involved.

```toml
[channels.code_agent]
provider = "codex"
permission_mode = "default"
working_dir = "~/projects/myrepo"
# model = "gpt-5.5"
```

Requirements:

- Install and authenticate the local `codex` CLI.
- Use a CLI version that supports `codex app-server` (verified with 0.153.1).
- Set `EGIRL_CODEX_BIN` to an absolute executable path when Codex is not on PATH. Native Windows `codex.exe` is supported without a Node or PTY shim.
- Run a local llama.cpp chat model for supervised approvals.

Codex permission modes map to CLI sandbox choices:

| egirl mode | Codex sandbox |
|------------|---------------|
| `bypassPermissions` | danger-full-access |
| `plan` | read-only |
| `default`, `acceptEdits` | workspace-write |

Codex ignores `max_turns`; the app-server reports when its turn completes. A successful tool result means Codex returned a final answer; read that answer for whether the requested work and tests succeeded. Timeouts and interrupted or failed turns always return failure, and the owned server process tree is stopped. Each delegation starts a fresh thread in the selected working directory. Threads are persisted (not ephemeral) so a timed-out thread can be resumed with `thread/resume`.

## OpenCode Backend

OpenCode uses the installed `opencode` CLI. egirl spawns `opencode serve` (bound to `127.0.0.1`, random port) for the duration of the task, creates a session over its HTTP API, and sends the task as a prompt. Permission requests arrive as structured events over the server's `/event` SSE stream and are routed through the local model supervisor the same way Claude Code's tool permissions are — no terminal screen-scraping involved.

```toml
[channels.code_agent]
provider = "opencode"
permission_mode = "default"
working_dir = "~/projects/myrepo"
# model = "anthropic/claude-sonnet-4-5"  # "provider/model" format
```

Requirements:

- Install and authenticate the local `opencode` CLI (`opencode auth login`).
- OpenCode ignores `max_turns`; the server decides when the prompt turn is complete.

OpenCode permission modes:

| egirl mode | OpenCode behavior |
|------------|--------------------|
| `bypassPermissions` | every permission request is auto-approved (`once`) without consulting the supervisor |
| anything else | each permission request is routed through the local model supervisor |

## Using the Tool

The local model decides when to call `code_agent`. Typical tasks:

- Multi-file refactors
- Debugging failures across unfamiliar code
- Writing or updating tests
- Implementing features with verification
- Repository cleanup that needs file edits and command output

Tool call shape:

```json
{
  "name": "code_agent",
  "arguments": {
    "task": "Fix the failing formatter tests and run the focused test file.",
    "working_dir": "/home/user/projects/egirl"
  }
}
```

The result includes the backend's final output plus metadata such as duration, session id, turns, or cost when the backend exposes it.

## When the code agent times out

A delegation that runs past `timeout_ms` is aborted, but the work it did stays in the tree: a merge may be committed, conflicts half-resolved, a venv half-built. A bare "timed out" leaves the operator guessing, so the tool result is a compact report instead:

```text
Code agent timed out after 1800s (claude, 58 turns, 41 tool calls). The work is partial: check the state below before retrying.

Last 10 of 41 actions:
- Bash: git add -A && git commit --no-edit
- Bash: python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
- Bash: .venv/bin/pytest tests/unit -q
- Grep: def handle_upload in src
- Edit: src/upload.py
- Bash: .venv/bin/pytest tests/integration -q

Last message from the agent:
Unit tests pass (412 passed). Merge is committed. Now running the integration suite...

git status --short:
 M src/upload.py

git diff --stat:
 src/upload.py | 12 +++++++-----
 1 file changed, 7 insertions(+), 5 deletions(-)

To continue: call code_agent again with resume_session="claude:4f7c2a10-..." and a narrower task for the remaining work (for example "continue: <next step only>"), or split the rest into smaller tasks.
```

- **Actions** are the last 10 tool calls with a one-line gist of the input (the command, file path, or pattern).
- **Last message** is the tail of the agent's most recent text, capped at ~1200 characters.
- **Git state** appears only when `working_dir` is a git work tree. `git status --short` and `git diff --stat` are each capped at 20 lines and run with a 3-second timeout; if git fails or is missing, the section is dropped and the report is still returned.
- **A pending permission decision does not outlive the run.** If the Claude run times out while the local supervisor is still deciding a permission, the callback answers "deny, interrupt" at once instead of writing a late answer to the aborted process. Older Agent SDKs (0.2.x) threw that late write as an unhandled `Operation aborted` and took egirl down; for a minute after each timeout exactly that rejection is logged instead, and any other unhandled rejection still crashes as before.
- **A timeout never fails over** to the next provider. The agent ran and left partial work; a second agent over the same tree is more likely to conflict than help. Failover remains for backends that could not run at all (missing binary, auth, quota, a server that never started).

### Resuming

Pass the printed value as `resume_session` with the next instruction as `task`:

```json
{
  "name": "code_agent",
  "arguments": {
    "task": "continue: the merge is done; run only tests/integration and report failures",
    "working_dir": "/home/user/projects/app",
    "resume_session": "claude:4f7c2a10-9b3e-4d8a-a1c2-6e0f5b7d9c31"
  }
}
```

The run gets a fresh timeout and keeps the agent's history. A resume runs only the backend that owns the session (the `provider:` prefix; a bare id uses the first configured provider) and never fails over. Prefer a narrower instruction or splitting the remaining work over repeating the original task — the same task will likely time out again.

| Backend | Report | Resume |
|---------|--------|--------|
| Claude | turns, actions (tool_use blocks), last assistant text, git, session id | SDK `resume` option |
| Codex | actions (commands, file changes, MCP/dynamic tools), last agent message, git, thread id | `thread/resume` (threads are persisted for this) |
| OpenCode | actions (tool parts from the event stream), last text part, git, session id | posts the next message to the existing session |

## Migration Notes

Existing Claude users do not need to change config immediately. This still works:

```toml
[channels.claude_code]
permission_mode = "bypassPermissions"
working_dir = "~/projects/myrepo"
```

For explicit tool config, copy those settings to `[channels.code_agent]` and set `provider = "claude"`:

```toml
[channels.code_agent]
provider = "claude"
permission_mode = "bypassPermissions"
working_dir = "~/projects/myrepo"
```

To switch the tool to Codex or OpenCode, change only the provider and any backend-specific model value:

```toml
[channels.code_agent]
provider = "codex"
permission_mode = "default"
working_dir = "~/projects/myrepo"
```

Keep `[channels.claude_code]` if you still use the direct `cc` command. It is not required for Codex- or OpenCode-backed `code_agent`.

## Related Docs

- [Claude Code Bridge](claude-code.md) for the direct `claude-code` / `cc` channel
- [Configuration Reference](configuration.md#channelscode_agent) for all config keys
- [Built-in Tools Reference](tools.md#code_agent) for the tool schema
