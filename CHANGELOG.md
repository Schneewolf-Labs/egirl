# Changelog

## 1.0.0 — 2026-11-01

First stable release. From here on, breaking changes to `egirl.toml`, the HTTP API or the
`egirl-peer` protocol bump the major version.

### What 1.0 covers

- **Operator** — a local llama.cpp model by default, or a Claude / Codex instance via
  `[operator] provider`, chosen once per instance.
- **`code_agent`** — delegates engineering work to Claude Code, Codex, opencode or any ACP
  agent on subscription auth, with supervisor permissions, spiral/repetition guards and a
  `verify` step that runs the repo's own checks afterward.
- **Memory and continuity** — hybrid keyword + semantic search on SQLite, auto-extraction,
  memory GC, conversation persistence, handoff and compaction.
- **Autonomy** — background tasks, cron schedules, the autonomy loop and awaiting-input tasks.
- **Peers** — `peer_message` and Wald discovery.
- **Reporting** — `report` notify/ask to a person or a supervising agent.
- **Surfaces** — CLI, Discord, XMPP, Telegram, Matrix, the HTTP API (`egirl api`) and ACP
  (`egirl acp`).
- **Tools** — files, shell, git, GitHub, Playwright browser, web research, skills, MCP.

### Changed

- The version lives in one place, `package.json`. The HTTP API root, the ACP agent info and
  the Codex / ACP client handshakes all report it (they previously disagreed: `0.1.0` and
  `0.2.0`).

### Added

- `egirl version` / `egirl --version`; `egirl help` shows the version in its header.
