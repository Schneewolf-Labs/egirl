# Safety

egirl includes a safety layer that sits between the LLM and tool execution. It prevents the agent from running destructive commands, accessing files outside allowed directories, or touching sensitive credentials — even if the local model hallucinates something dangerous.

All safety features are independently configurable via sub-sections under `[safety]` in `egirl.toml`. Each feature has its own `enabled` flag so you can turn things on and off individually.

## Quick Start

Safety is enabled by default with sensible defaults. Out of the box you get command filtering, sensitive file protection, and audit logging. No configuration needed.

```toml
[safety]
enabled = true                          # master switch

[safety.command_filter]
enabled = true                          # block dangerous shell commands

[safety.sensitive_files]
enabled = true                          # block access to secrets/keys

[safety.audit_log]
enabled = true
path = "{workspace}/audit.log"          # JSONL log of all tool calls

[safety.path_sandbox]
enabled = false                         # opt-in: restrict file ops to dirs

[safety.confirmation]
enabled = false                         # opt-in: require confirmation
```

## Features

### Command Filter

`[safety.command_filter]`

Checks every `execute_command` call against regex patterns before running it. Built-in patterns block:

| Pattern | What it catches |
|---------|----------------|
| `rm (-flags) /` | Recursive delete from root |
| `mkfs.` | Filesystem formatting |
| `dd ... of=/dev/` | Direct disk writes |
| `:() { ...` | Fork bombs |
| `chmod (-R) 777 /` | World-writable permissions from root |
| `curl \| sh` | Piping downloads to shell |
| `wget \| sh` | Piping downloads to shell |
| `> /dev/sd` | Overwriting disk devices |
| `shutdown/reboot/halt/poweroff` | System power commands |
| `pkill -9 init/systemd` | Killing init process |

Add custom patterns (appended to built-in list):

```toml
[safety.command_filter]
enabled = true
blocked_patterns = ["npm\\s+publish", "docker\\s+rm\\s+-f"]
```

Disable:

```toml
[safety.command_filter]
enabled = false
```

### Path Sandbox

`[safety.path_sandbox]`

When enabled, file operations (`read_file`, `write_file`, `edit_file`, `glob_files`) are restricted to the listed directories. Paths are resolved and normalized before checking.

**Disabled by default** — the agent can access any file the process user can.

```toml
[safety.path_sandbox]
enabled = true
allowed_paths = ["{workspace}", "~/projects/myrepo"]
```

### Sensitive Files

`[safety.sensitive_files]`

Blocks `read_file`, `write_file`, and `edit_file` from touching files that match sensitive patterns. Built-in patterns:

- `.env`, `.env.*` — environment secrets
- `id_rsa`, `id_ed25519`, `id_ecdsa` — SSH private keys
- `.pem`, `.key` — TLS/SSL private keys
- `.ssh/config` — SSH configuration
- `.npmrc`, `.pypirc` — package registry credentials
- `credentials.json` — service account keys
- `.git-credentials` — Git credential store
- `.aws/credentials` — AWS credentials
- `.docker/config.json` — Docker auth

Add custom patterns (appended to built-in list):

```toml
[safety.sensitive_files]
enabled = true
patterns = ["secret\\.yaml$", "vault-token"]
```

### Audit Log

`[safety.audit_log]`

Logs every tool call to a JSONL file — including blocked calls.

```toml
[safety.audit_log]
enabled = true
path = "{workspace}/audit.log"
```

Each line is a JSON object:

```json
{"timestamp":"2025-06-15T10:30:00.000Z","tool":"execute_command","args":{"command":"ls -la"},"blocked":false,"success":true}
{"timestamp":"2025-06-15T10:30:05.000Z","tool":"execute_command","args":{"command":"rm -rf /"},"blocked":true,"reason":"Command matches blocked pattern: rm\\s+(-\\w+\\s+)*/"}
```

Append-only, fire-and-forget (write failures logged as warnings, don't block execution).

### Confirmation

`[safety.confirmation]`

When enabled, destructive tools are blocked unless a confirmation callback is registered on the `ToolExecutor`. You can customize which tools require confirmation.

```toml
[safety.confirmation]
enabled = true
tools = ["execute_command", "write_file", "edit_file"]
```

Channel implementations register a callback via `toolExecutor.setConfirmCallback(fn)` to prompt the user. If no callback is registered, the tools are simply blocked.

## Architecture

```
Tool Call
    ↓
ToolExecutor.execute()
    ↓
checkToolCall(config)
    ├── [command_filter.enabled?] isCommandBlocked()
    ├── [path_sandbox.enabled?]   isPathAllowed()
    ├── [sensitive_files.enabled?] isSensitivePath()
    └── [confirmation.enabled?]   needsConfirmation
    ↓
[blocked] → return error + audit log
[allowed] → tool.execute() → audit log
```

Each check is gated by its own `enabled` flag. The master `safety.enabled` switch short-circuits all checks when `false`.

Safety checks run in `ToolExecutor` before any tool code executes. The safety module (`src/safety/`) is pure functions with no side effects (except audit logging), making it easy to test.

## Configuration Reference

### `[safety]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Master switch for all safety features |

### `[safety.command_filter]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Enable command blocklist |
| `blocked_patterns` | string[] | `[]` | Additional regex patterns (appended to built-in) |

### `[safety.path_sandbox]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `false` | Enable path restrictions |
| `allowed_paths` | string[] | `[]` | Directories file ops are restricted to |

### `[safety.sensitive_files]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Enable sensitive file detection |
| `patterns` | string[] | `[]` | Additional regex patterns (appended to built-in) |

### `[safety.audit_log]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Enable audit logging |
| `path` | string | — | Path to JSONL audit log file |

### `[safety.confirmation]`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `false` | Enable confirmation for destructive tools |
| `tools` | string[] | `["execute_command", "write_file", "edit_file"]` | Tools that require confirmation |

## Disabling Safety

Kill everything:

```toml
[safety]
enabled = false
```

Or disable individual features:

```toml
[safety]
enabled = true

[safety.command_filter]
enabled = false

[safety.sensitive_files]
enabled = false

[safety.audit_log]
enabled = false
```

This is a single-user tool running on your hardware. If you trust your local model and want zero overhead, turning it off is fine.
