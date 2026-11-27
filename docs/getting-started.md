# Getting Started

egirl needs two things: [Bun](https://bun.sh) and one operator model. The operator is the model
that runs every turn. Everything else (embeddings, a code agent, web search, MCP servers, a
second model for side work) is optional. egirl runs without it and says what is missing.

This guide gets you from nothing to a first turn in the terminal. When it works, add optional
services one at a time: [optional-services.md](optional-services.md).

## 1. Install

```bash
git clone https://github.com/Schneewolf-Labs/egirl.git
cd egirl
bun install
```

## 2. Pick an operator

| Option | You run | Config |
|--------|---------|--------|
| A. llama.cpp | `llama-server` on this machine or your LAN | `[local] endpoint`, `model` |
| B. Hosted OpenAI-compatible API | nothing; you need an API key | `[local] hosted = true` |
| C. Claude | nothing; you need Claude Code signed in on this machine | `[operator] provider = "claude"`, `[local] provider = "claude"` |

The choice is made once per instance. egirl never switches operators per message.

### A. llama.cpp

Start a server with a model that can call tools:

```bash
llama-server -m your-model.gguf -c 32768 -fa on --jinja --cache-reuse 256 --port 8080
```

`--jinja` makes the server apply the model's own chat template. For the other flags and for
sizing the context, see [deployment.md](deployment.md).

```toml
[local]
endpoint = "http://localhost:8080"
model = "qwen3-32b"       # a label; doctor warns if it shares no word with what the server reports
context_length = 32768    # the window egirl plans for
```

If the server reports a smaller `n_ctx` than `context_length`, egirl lowers `context_length` to
match at startup and logs a warning.

Other local OpenAI-compatible servers (vLLM, Ollama, LM Studio) are not llama-server. egirl
leaves `model` out of its requests and adds llama.cpp's own fields. If your server needs the
model named, or rejects fields it doesn't know, set `hosted = true` as in option B.

### B. A hosted OpenAI-compatible API

```toml
[local]
endpoint = "https://api.example.com"   # the bare host: egirl appends /v1/chat/completions
model = "the-model-id"                 # must be one the API lists at /v1/models
context_length = 32768
hosted = true
```

Put the key in `.env` beside the config:

```bash
EGIRL_LOCAL_API_KEY=sk-...
```

With `hosted = true`, egirl names the model on every request and sends only standard OpenAI
fields. You lose what depended on llama.cpp: `/think` cannot switch thinking, sessions are not
pinned to cache slots, and token counts are estimates.

### C. Claude on your Claude login

```toml
[operator]
provider = "claude"

[local]
provider = "claude"
model = "haiku"
```

`[operator] provider = "claude"` runs each session as a Claude Code session on your
subscription. `[local] provider = "claude"` puts the side work (memory extraction, the
permission supervisor, task self-review) on Claude too, using the model named in `model`. With
both, no model server is needed. You need Claude Code signed in on this machine
(`claude login`). egirl needs no `ANTHROPIC_API_KEY`.

Without `[local] provider = "claude"`, a Claude operator still sends side work to the `[local]`
endpoint. If nothing answers there, memory extraction fails, and the permission supervisor
denies every code-agent permission request its policy rules don't settle.

What a Claude instance keeps and what it leaves to Claude Code:
[configuration.md](configuration.md#operator).

`[operator] provider = "codex"` also exists: a Codex app-server thread on your ChatGPT login
(`codex` CLI 0.163 or later). A Codex operator still needs a `[local]` model (option A or B) for
side work, since `[local] provider = "claude"` is only allowed on a Claude instance.

## 3. Write the config

In the checkout, copy the example into `egirl.d/`:

```bash
mkdir -p egirl.d
cp egirl.example.toml egirl.d/local.toml
```

Edit `egirl.d/local.toml` and keep one of the three operator blocks. Everything else in it is
commented out.

Why `egirl.d/`: the repo's own `egirl.toml` is tracked in git and is a shared base (safety
settings, `[tools] code_agent = true`, `[tools] tasks = true`). Files in `egirl.d/` are
gitignored and merged over it in filename order.

egirl uses the first config it finds:

1. the file named by `EGIRL_CONFIG`
2. `./egirl.toml`
3. `~/.egirl/egirl.toml`
4. `~/.config/egirl/egirl.toml`

plus any `egirl.d/*.toml` beside it. `bun run start init` writes a starter `egirl.toml` and
`.env`, but only into a directory that has neither: in the checkout it skips `egirl.toml`,
because one is already there.

## 4. Check it with `doctor`

```bash
bun run start doctor
```

A real run (egirl with PR #259 or later): option A, llama-server serving `B6-27B-Q8_0.gguf`,
`model = "b6-27b"`, the example config with nothing else turned on:

```
  ok config /path/to/egirl.toml
  ok endpoint configured: http://127.0.0.1:8195
  ok local model http://127.0.0.1:8195 is reachable
  skip code agent tool off (optional: docs/optional-services.md#code-agent)
  ok permissions supervised, default=allow
  ok served model B6-27B-Q8_0.gguf
setup looks usable
```

| Line | What it means |
|------|---------------|
| `config` | Which file was loaded |
| `endpoint` | The configured `[local] endpoint`. Only its form is checked |
| `local model` | `GET /v1/models` on that endpoint answered. On option C it reads `side work on Claude (haiku)` |
| `code agent tool`, `code agent config`, `<name> cli` | The code agent. Off is `skip`. On but with no `[channels.code_agent]` is `warn`; the repo's base `egirl.toml` turns the tool on, so a checkout shows that warning until you configure one. A configured provider whose CLI is missing is `fail` |
| `permissions` | The permission supervisor's mode |
| `served model` | What the server says it is serving, compared with your `model` label (`warn` if they don't match). On a hosted API, whether your model is in its list |

Lines for embeddings, an auxiliary model, MCP servers and the API port show up once you
configure them. `skip` and `warn` lines don't count as issues. Only `fail` makes doctor exit
with status 1.

**Before PR #259**, the same setup printed `fail` for the unconfigured code agent and exited 1.
It also warned `served model serving B6-27B-Q8_0.gguf, config says b6-27b`, because the name
check ignored words shorter than four characters, and labelled the endpoint line `ok endpoint
<url>`. None of that means anything is wrong.

Doctor doesn't check a Claude or Codex login. Your first turn does.

When the operator is down, doctor's behaviour depends on the version:

- **Before PR #259**, doctor stops after the `local model` line. It skips the served-model,
  embeddings, auxiliary, MCP and API-port checks.
- **With PR #259 or later**, it probes every dependency anyway. Only the `served model` check
  shows as `skip`. Interactive `cli`, `serve` and `api` also print one `[deps]` warning at
  startup for each configured dependency that is down.

## 5. First turn

```bash
bun run cli
```

Or send one message and exit:

```bash
bun run start cli -m "hello"
```

On the first run egirl creates the workspace (`~/.egirl/workspace` by default) and fills it with
starter personality files: `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md` and the rest. Edit
them to make the agent yours: [personality.md](personality.md).

On a minimal config, two startup warnings are expected:

- `[tools] web_search = true but no [searxng] url is configured`: web search needs SearXNG.
  `web_research` (fetching a URL) works without it.
- `[tools] code_agent = true but no [channels.code_agent] ...`: this comes from the repo's shared
  base `egirl.toml`.

Each warning names the setting that silences it.

To run `egirl` from any directory, `bun run start install` puts a launcher in `~/.local/bin`.

## What you don't need yet

| Service | Without it |
|---------|------------|
| Embeddings | Memory uses keyword search (SQLite FTS5). `memory_*` tools, recall and log indexing all work. Only matching by meaning is missing |
| Code agent | No `code_agent` tool. The operator still has the shell, files, git and the web |
| SearXNG | No `web_search` tool. `web_research` still fetches pages |
| MCP servers | No extra tools |
| Auxiliary model | Side work (compaction summaries, memory extraction) runs on the operator |
| Python | Only the Python embedding service (`services/embeddings`) needs it. The llama.cpp embedding option doesn't |
| A GPU | Only a local operator needs one. Options B and C need none |

Add them in roughly this order of value: embeddings, a code agent, web search or MCP, then an
auxiliary model. How to run each one, and what happens when it goes down:
[optional-services.md](optional-services.md).
