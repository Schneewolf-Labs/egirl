# Code Agent Integration

`code_agent` is egirl's primary delegation tool for real engineering work. The local model stays in charge of planning and supervision, then hands coding tasks to a configured backend that can inspect the repository, edit files, run commands, and iterate.

Supported backends:

- **Claude Code** through `@anthropic-ai/claude-agent-sdk`
- **Codex** through the local interactive `codex` CLI in a PTY

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
provider = "claude"          # "claude" or "codex"
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

To switch the tool to Codex, change only the provider and any backend-specific model value:

```toml
[channels.code_agent]
provider = "codex"
permission_mode = "default"
working_dir = "~/projects/myrepo"
```

Keep `[channels.claude_code]` if you still use the direct `cc` command. It is not required for Codex-backed `code_agent`.

## Related Docs

- [Claude Code Bridge](claude-code.md) for the direct `claude-code` / `cc` channel
- [Configuration Reference](configuration.md#channelscode_agent) for all config keys
- [Built-in Tools Reference](tools.md#code_agent) for the tool schema
