# Safety

egirl includes a safety layer that sits between the LLM and tool execution. It prevents the agent from running destructive commands, accessing files outside allowed directories, or touching sensitive credentials — even if the local model hallucinates something dangerous.

All safety features are configurable via the `[safety]` section in `egirl.toml`.

## Quick Start

Safety is enabled by default with sensible defaults. No configuration needed for basic protection. To customize:

```toml
[safety]
enabled = true
audit_log = "{workspace}/audit.log"
# blocked_patterns = ["extra_regex"]
# allowed_paths = ["{workspace}", "~/projects"]
# sensitive_patterns = ["secret\\.yaml$"]
require_confirmation = false
```

## Features

### Command Blocklist

The `execute_command` tool checks every command against a set of regex patterns before running it. Built-in patterns block:

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

Add custom patterns in config:

```toml
[safety]
blocked_patterns = ["npm\\s+publish", "docker\\s+rm\\s+-f"]
```

Custom patterns are added **on top of** the built-in list, not replacing it.

### Path Sandboxing

When `allowed_paths` is set, file operations (`read_file`, `write_file`, `edit_file`, `glob_files`) are restricted to those directories. Paths are resolved and normalized before checking.

```toml
[safety]
allowed_paths = ["{workspace}", "~/projects/myrepo"]
```

If `allowed_paths` is empty (the default), no path restriction is applied — the agent can access any file the process user can access.

### Sensitive File Guard

Certain file patterns are always blocked from `read_file`, `write_file`, and `edit_file`, regardless of path sandboxing. Built-in patterns:

- `.env`, `.env.*` — environment secrets
- `id_rsa`, `id_ed25519`, `id_ecdsa` — SSH private keys
- `.pem`, `.key` — TLS/SSL private keys
- `.ssh/config` — SSH configuration
- `.npmrc`, `.pypirc` — package registry credentials
- `credentials.json` — service account keys
- `.git-credentials` — Git credential store
- `.aws/credentials` — AWS credentials
- `.docker/config.json` — Docker auth

Add custom patterns:

```toml
[safety]
sensitive_patterns = ["secret\\.yaml$", "vault-token"]
```

### Audit Log

When `audit_log` is set, every tool call is logged to a JSONL file — including blocked calls.

```toml
[safety]
audit_log = "{workspace}/audit.log"
```

Each line is a JSON object:

```json
{"timestamp":"2025-06-15T10:30:00.000Z","tool":"execute_command","args":{"command":"ls -la"},"blocked":false,"success":true}
{"timestamp":"2025-06-15T10:30:05.000Z","tool":"execute_command","args":{"command":"rm -rf /"},"blocked":true,"reason":"Command matches blocked pattern: rm\\s+(-\\w+\\s+)*/"}
```

The audit log is append-only and fire-and-forget (write failures are logged as warnings but don't block tool execution).

### Confirmation Mode

When `require_confirmation` is enabled, destructive tools (`execute_command`, `write_file`, `edit_file`) are blocked unless a confirmation callback is registered on the `ToolExecutor`.

```toml
[safety]
require_confirmation = true
```

Channel implementations can register a callback via `toolExecutor.setConfirmCallback(fn)` to prompt the user before execution. If no callback is registered, destructive tools are simply blocked.

## Architecture

```
Tool Call
    ↓
ToolExecutor.execute()
    ↓
checkToolCall()
    ├── isCommandBlocked()     → command blocklist
    ├── isPathAllowed()        → path sandboxing
    ├── isSensitivePath()      → sensitive file guard
    └── requireConfirmation?   → confirmation mode
    ↓
[blocked] → return error + audit log
[allowed] → tool.execute() → audit log
```

Safety checks run in `ToolExecutor` before any tool code executes. The safety module (`src/safety/`) is pure functions with no side effects (except audit logging), making it easy to test.

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Master switch for all safety features |
| `audit_log` | string | — | Path to JSONL audit log file |
| `blocked_patterns` | string[] | `[]` | Additional regex patterns for command blocklist |
| `allowed_paths` | string[] | `[]` | Directories file ops are restricted to (empty = no restriction) |
| `sensitive_patterns` | string[] | `[]` | Additional regex patterns for sensitive file detection |
| `require_confirmation` | bool | `false` | Require confirmation for destructive tools |

## Disabling Safety

To disable all safety checks:

```toml
[safety]
enabled = false
```

This is a single-user tool running on your hardware. If you trust your local model and want zero overhead, turning it off is fine.
