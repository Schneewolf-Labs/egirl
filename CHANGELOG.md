# Changelog

## Unreleased — feature/hermes-cc-convergence

Convergence features adopted from both Hermes Agent and Claude Code architectures.

### Added

- **Continuation retries for truncated responses** — All providers (llama.cpp, Anthropic, OpenAI)
  now expose `finish_reason` on `ChatResponse`. When a response is truncated
  (`finish_reason: length`), the agent loop automatically retries with a continuation
  prompt, concatenating partial outputs (up to 3 retries).

- **Prompt injection scanning on tool outputs** — New shared `injection-scanner` module in the
  safety layer detects ChatML markers, override attempts, hidden instructions, and control
  characters in tool outputs from external-facing tools (`web_research`, `browser_*`,
  `execute_command`, `read_file`, `code_agent`). Detected patterns are stripped and flagged.

- **Pattern-based permission rules** — New `[safety.permission_rules]` config section supports
  glob-pattern allow/deny rules for tool calls (e.g. `execute_command(git **)`,
  `read_file(/home/**)`). Deny rules are evaluated first; first match wins. Evaluated before
  all other safety checks.

- **Post-response validation hooks** — New `onPostResponseValidation` event on
  `AgentEventHandler` lets channels inspect the model's final text response and reject it
  with feedback, triggering a single retry with the feedback injected as context.

- **Interior message compaction** — Context window fitting now protects the first user message
  (task context) and the most recent messages, dropping only middle turns for summarization.
  Previously used a simple drop-oldest sliding window.

- **Deferred tool loading** — New `tool_search` meta-tool and `deferred-loader` module allows
  sending a compact tool index in the system prompt instead of all ~48 full schemas. The model
  calls `tool_search` to load full schemas on demand, saving ~3K tokens from the context window.

- **System prompt caching for Anthropic** — System prompt is now split into stable (personality,
  tools, skills) and volatile (working memory, additional context) sections. When using
  Anthropic as the remote provider, the stable prefix gets `cache_control: ephemeral` for
  prefix caching (~75% input cost reduction on cache hits).

- **Stale-stream detection for llama.cpp** — Detects when local inference stalls (no new tokens
  for a configurable timeout, default 90s) and aborts the stream. Stale aborts set
  `finish_reason: length` so continuation retries kick in automatically. Configurable via
  `[local.stale_stream_timeout_ms]` in `egirl.toml`.

### Fixed

- Standup tests now handle both `main` and `master` as the default branch name, fixing
  failures on systems where `git init` defaults to `main`.

### Config

New config keys:

```toml
[local]
stale_stream_timeout_ms = 90000  # Stale-stream abort timeout (default: 90s)

[safety.permission_rules]
allow = ["execute_command(git **)", "read_file(/home/**)"]
deny = ["execute_command(rm **)", "read_file(/etc/**)"]
```
