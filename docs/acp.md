# Agent Client Protocol (ACP)

[ACP](https://agentclientprotocol.com) is JSON-RPC over stdio between a *client* (usually an editor) and an *agent*. egirl speaks it in both directions, through the official TypeScript SDK (`@agentclientprotocol/sdk`):

- **egirl as an ACP agent** — `egirl acp` serves the protocol on stdio, so Zed, a JetBrains IDE, or any ACP client can run egirl as its agent.
- **egirl as an ACP client** — the `acp` code-agent provider spawns any ACP agent and uses it as `code_agent`. One protocol covers Gemini CLI (native), Claude Code and Codex (through adapters), opencode, and anything else that ships an ACP mode.

Both halves are deliberately small first versions. What is missing is listed at the end.

## egirl as an ACP agent

```bash
bun run src/index.ts acp            # or: egirl acp
bun run src/index.ts --instance ops acp
```

stdout carries the protocol; every log line goes to stderr. Config is loaded the usual way (`egirl.toml`, `--instance`), and the session runs on the instance's local model, memory, skills and tools, exactly as a CLI session would.

What it does:

| Method | Behavior |
|--------|----------|
| `initialize` | Protocol v1. Advertises `loadSession: false`, prompt capabilities `image` and `embeddedContext`, no auth methods. Requires no client fs/terminal capabilities |
| `session/new` | Creates an egirl session `acp:<uuid>`. `cwd` must be absolute. Client MCP servers are ignored (logged) |
| `session/prompt` | Runs the agent loop on the prompt. Text blocks are the message; `resource_link` blocks are named as files to read; text `resource` blocks are inlined; images are passed as `data:` URLs. Streams `agent_message_chunk`, `agent_thought_chunk`, `tool_call` and `tool_call_update` notifications, then returns `end_turn`, `cancelled`, or `max_turn_requests` (the turn cap ended the run) |
| `session/cancel` | Aborts the running prompt; it returns `cancelled` |
| anything else | JSON-RPC `-32601 Method not found`. A failed run is a JSON-RPC error on that request; the connection stays up |

**Working directory.** egirl's tools resolve relative paths against the persona workspace (where `SOUL.md`, `MEMORY.md` and the rest live), and that does not change per session. Instead, the editor's `cwd` goes into the session's system prompt: the agent is told the project lives there, to use absolute paths under it, and to pass it as `working_dir` when it delegates to `code_agent`.

### Zed

In Zed's `settings.json`:

```json
{
  "agent_servers": {
    "egirl": {
      "command": "bun",
      "args": ["run", "/path/to/egirl/src/index.ts", "acp"],
      "env": {}
    }
  }
}
```

Then pick **egirl** in the agent panel. Add `"--instance", "<name>"` before `"acp"` to run a named instance. Zed's settings schema for external agents has changed between releases (newer ones may want `"type": "custom"`); its *External Agents* docs have the current shape.

### JetBrains IDEs

JetBrains AI Assistant reads custom ACP agents from `~/.jetbrains/acp.json`:

```json
{
  "agent_servers": {
    "egirl": {
      "command": "bun",
      "args": ["run", "/path/to/egirl/src/index.ts", "acp"]
    }
  }
}
```

The exact file and UI move between IDE releases; any client that launches a command and speaks ACP on its stdio works the same way.

## egirl as an ACP client: the `acp` provider

```toml
[channels.code_agent]
provider = "acp"
acp_command = ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]
permission_mode = "default"
timeout_ms = 1800000
```

`acp_command` is the agent's command line as an array. Examples:

| Agent | `acp_command` |
|-------|---------------|
| Gemini CLI (native) | `["gemini", "--acp"]` (older releases: `["gemini", "--experimental-acp"]`) |
| Claude Code (adapter) | `["npx", "-y", "@agentclientprotocol/claude-agent-acp"]` |
| Codex (adapter) | `["npx", "-y", "@agentclientprotocol/codex-acp"]` |
| opencode | `["opencode", "acp"]` |

Each agent authenticates the way it does on its own (`gemini` login, Claude Code subscription, `codex login`, `opencode auth login`); egirl does not run ACP `authenticate`.

`acp` can sit in a failover chain like any other provider: `providers = ["acp", "claude"]`. A missing `acp_command`, a binary that is not on PATH, or an agent that answers with no text counts as "could not run" and fails over.

Per delegated task, egirl:

1. spawns `acp_command` in the working dir, with the sanitized environment the other backends get (secret-shaped variables stripped);
2. sends `initialize` (no fs or terminal capabilities: the agent uses its own tools), then `session/new` with `cwd` = the working dir;
3. sends the task (and any image paths, named in the text) as one `session/prompt`;
4. collects `agent_message_chunk` text as the tool result, and counts `tool_call`s for the metadata line;
5. ends the process when the turn ends.

Only an `end_turn` stop with non-empty text is success. Any other stop reason, an error, or an empty answer is a failure carrying whatever text arrived.

### Permissions

`session/request_permission` is answered by the [permission supervisor](permissions.md) with the same contract as the other backends:

| Supervisor decision | Answer to the agent |
|---------------------|---------------------|
| `allow`, or `choose` an allow option | the `allow_once` option. Never `allow_always`: that would persist in the agent's own settings for every later run |
| `deny`, or `choose` a reject option | the `reject_once` option. ACP has no field for a reason, so a deny cannot carry re-steering guidance |
| `ask_user` | the request is answered `cancelled`, the turn gets `session/cancel`, and the tool returns "Code agent needs user approval" with any partial output |

With no active supervisor (`[permission_supervisor] mode = "bypass"`, or none configured), `permission_mode` decides by the tool call's ACP `kind`:

| `permission_mode` | Allowed without asking |
|-------------------|------------------------|
| `bypassPermissions` | everything |
| `acceptEdits` | `read`, `search`, `think`, `edit` |
| `default`, `plan` | `read`, `search`, `think` |

Everything else is rejected. Most agents only ask about writes and commands in the first place; whether `plan` keeps the agent from editing without asking is up to the agent.

### Timeouts

`timeout_ms` (default 5 minutes) is the wall clock for the whole task. At the deadline egirl sends `session/cancel`, gives the agent up to 3 seconds to stop, then kills the process tree. The result is a failure reading "Code agent timed out after Ns" with whatever text had streamed.

### Windows

The agent is started through the shell on Windows so `npx` and other `.cmd` shims resolve. Avoid spaces in `acp_command` arguments there.

## Not implemented yet

- **Agent side:** `session/load`, `session/list`, session modes and config options, `authenticate`; MCP servers passed in `session/new`; using the client's `fs/*` and `terminal/*` (egirl's own tools do the work); per-session tool cwd (see *Working directory*); plans (`plan` updates); usage updates; asking the editor's user for permission via `session/request_permission` (egirl's own safety layer and supervisor apply instead).
- **Client side:** `fs/*` and `terminal/*` client capabilities; passing `model` to the agent (`[channels.code_agent] model` is ignored for `acp`; configure the model in the agent itself); `max_turns`; `authenticate`; image content blocks (images are named as file paths in the task text); streaming the agent's progress into egirl's own session narration; resuming a session across delegations.
