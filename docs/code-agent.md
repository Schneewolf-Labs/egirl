# Code Agent Integration

`code_agent` is egirl's primary delegation tool for real engineering work. The local model stays in charge of planning and supervision, then hands coding tasks to a configured backend that can inspect the repository, edit files, run commands, and iterate.

Supported backends:

- **Claude Code** through `@anthropic-ai/claude-agent-sdk`
- **Codex** through the local interactive `codex` CLI in a PTY
- **OpenCode** through a locally-spawned `opencode serve` HTTP server

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

Codex uses the installed `codex` CLI in interactive mode. egirl starts it in a PTY, watches the terminal screen, and asks the local model to choose numbered responses for trust prompts, permission prompts, and clarifying questions.

```toml
[channels.code_agent]
provider = "codex"
permission_mode = "default"
working_dir = "~/projects/myrepo"
# model = "gpt-5.5"
```

Requirements:

- Install and authenticate the local `codex` CLI.
- Keep `node-pty` installed through `bun install`.
- Run a local llama.cpp chat model, because egirl uses it to decide Codex interactive prompts.

Codex permission modes map to CLI sandbox choices:

| egirl mode | Codex sandbox |
|------------|---------------|
| `bypassPermissions` | danger-full-access |
| anything else | workspace-write |

Codex ignores `max_turns`; the CLI decides when the interactive task is complete.

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

## Background Delegations

A foreground `code_agent` call blocks the operator for the whole job. That is fine for a
five-minute fix and wrong for a long one: the operator cannot see what the delegate is doing,
cannot correct a run that has gone the wrong way, and cannot end one without losing the work.

`background: true` turns the delegation into a handle instead — the same shape `process_start`
gives a long-running shell command:

```json
{
  "name": "code_agent",
  "arguments": {
    "task": "Split src/agent/loop.ts into loop + chat + background",
    "working_dir": "/home/user/projects/egirl",
    "background": true
  }
}
```

The call returns a delegation id (`d3f9a1`) immediately and the operator carries on. Three
tools act on it:

| Tool | What it does |
|------|--------------|
| `code_agent_status` | List delegations, or show one delegation's progress and — once settled — its full result. `since_line` returns only what is new. |
| `code_agent_steer` | Send a correction into a running delegation. It arrives as the next user turn in that delegate's own session, so everything it has already worked out is kept. |
| `code_agent_stop` | End a run. Files it already wrote stay written, and whatever it reported stays readable through `code_agent_status`. |

When a delegation finishes, its result is delivered to the operator at the next turn boundary
rather than waiting to be polled — a delegation that lands while the agent is idle is read on
the next run. Steering, stops and completions all land at turn boundaries for the same reason
interjections do: a user message spliced between a tool call and its results would corrupt the
transcript the model sees.

Background runs get a 30-minute default ceiling rather than the foreground five, since nothing
is blocked while they work. An explicit `timeout_ms` still wins over both.

### Steering support by backend

| Backend | Steerable | Stop | Progress |
|---------|-----------|------|----------|
| `claude` | Yes — the prompt is sent as an open stream, so a steer becomes another turn in the same session | Yes | Assistant text and tool names |
| `codex` | No — the PTY is mid-render and injecting text confuses its completion detection | Yes | Completed-step bullets |
| `opencode` | No | Yes | None |

Capability is declared, not assumed: `code_agent_steer` on a backend that cannot take input
says so and tells the operator to stop and re-delegate, rather than accepting a message that
goes nowhere. The same rule covers failover — if a delegation falls back to a backend that
cannot steer, queued steers are dropped with a note in the progress log instead of silently.

Failover itself is narrower in the background than in the foreground: a backend that fails
**after** producing progress is not retried on the next provider, because that would start a
second agent over half-finished work under the same delegation id.

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
