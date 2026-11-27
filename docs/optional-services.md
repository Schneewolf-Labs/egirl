# Optional Services

egirl needs Bun and one operator model ([getting-started.md](getting-started.md)). Everything on
this page is optional. Without it, egirl still runs, with less.

Rough order of value:

1. [Embeddings](#embeddings): memory recall by meaning
2. [Code agent](#code-agent): hand coding work to Claude Code, Codex, opencode or an ACP agent
3. [Web search](#web-search-searxng) and [MCP servers](#mcp-servers): more tools
4. [Auxiliary model](#auxiliary-model): side work off the operator's slot

## Summary

| Service | Not configured | Configured but down |
|---------|----------------|---------------------|
| Embeddings | Memory uses keyword search (SQLite FTS5). All memory tools, recall and log indexing work | Recall falls back to keyword search and recovers on its own. Memories saved meanwhile get no embedding, and nothing adds one later |
| Code agent | No `code_agent` tool | The tool is offered, and a call returns `Code agent error: ...`. A `providers` chain tries the next backend |
| SearXNG | No `web_search` tool; one startup warning | `web_search` returns an error per call |
| MCP server | No extra tools | That server's tools are missing until restart; the others still load |
| Auxiliary model | Side work runs on the operator | Side work falls back to the operator, after one warning (egirl newer than PR #258) |

`egirl doctor` reports each configured service. Before PR #259, doctor checks embeddings, the
auxiliary model and MCP servers only when the operator answers. With PR #259 or later it checks
them all, and interactive `cli`, `serve` and `api` print one `[deps]` warning at startup for each
configured dependency that is down.

## Embeddings

**What it adds.** Memory search matches by meaning as well as by keyword. A search blends the
two, weighted 70% vector and 30% keyword, before recency and importance are added. Auto-extracted memories are also checked for
near-duplicates before they are stored.

**Without it.** Memory still works: `memory_search`, `memory_set` and the other `memory_*`
tools, recall before each turn, auto-extraction and log indexing all run on SQLite FTS5 keyword
search. Startup logs `Memory system initialized with keyword search (no embeddings configured)`.

There are two ways to run an embedding service.

### Option A: nomic-embed-text on llama.cpp (small, CPU)

A 146 MB download. It runs on the CPU and returns 768-dimension vectors.

```bash
hf download nomic-ai/nomic-embed-text-v1.5-GGUF nomic-embed-text-v1.5.Q8_0.gguf --local-dir ~/models
llama-server -m ~/models/nomic-embed-text-v1.5.Q8_0.gguf --embedding -ngl 0 -c 2048 --host 127.0.0.1 --port 8083
```

```toml
[local.embeddings]
provider = "llamacpp"
endpoint = "http://127.0.0.1:8083"
model = "nomic-embed-text-v1.5"
dimensions = 768
multimodal = false
```

The `llamacpp` provider posts text to `/v1/embeddings`. `multimodal` defaults to `true`, but
this is a text model, so set it to `false`. Nothing in egirl embeds images today, so the flag
has no effect yet.

### Option B: services/embeddings (Qwen3-VL-Embedding-2B, Python)

Multimodal, with 2048-dimension vectors. It needs Python 3 and torch, and runs on the CPU.

```bash
cd services/embeddings && ./run.sh
```

On the first run, `run.sh` creates `venv/`, installs `requirements.txt`, and downloads
`Qwen/Qwen3-VL-Embedding-2B`. It serves on port 8082 (`PORT=...` to change it) and binds
`0.0.0.0` (`./run.sh --host 127.0.0.1` to keep it local).

`requirements.txt` installs torch from PyPI, which on Linux pulls in the CUDA libraries the
service never uses. For CPU-only wheels, create the venv yourself first; `run.sh` then skips its
own install:

```bash
cd services/embeddings
python3 -m venv venv
venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
venv/bin/pip install -r requirements.txt
./run.sh
```

```toml
[local.embeddings]
provider = "qwen3-vl"
endpoint = "http://localhost:8082"
model = "qwen3-vl-embedding-2b"
dimensions = 2048
multimodal = true
```

The `qwen3-vl` provider posts to the service's `/embed` and sends `dimensions` with each
request. The service truncates its vectors to that size.

### Option C: an OpenAI-compatible embeddings API

`provider = "openai"` posts to `{base_url}/embeddings` (default `https://api.openai.com/v1`).
It needs `api_key` in the `[local.embeddings]` block; there is no env var for it. Without one,
the provider fails to start, and memory falls back to keyword search with a warning.

### Always set `endpoint` and `model`

The schema lists defaults for them, but the loader doesn't apply those defaults. A
`[local.embeddings]` block without `endpoint` leaves egirl with no endpoint to report: the
startup log reads `@ undefined`, and doctor's probe fails.

### Doctor and startup

- `doctor`: an `embeddings` line, from `GET {endpoint}/health`. Before PR #259, a failure reads
  `(memory will not work)`, which is wrong: memory falls back to keyword search. With PR #259 or
  later, it reads `(memory falls back to keyword search; memories saved meanwhile are never
  embedded)`.
- Startup: `Memory system initialized: <provider>/<model> @ <endpoint>`. With PR #259 or later,
  a down service adds `[deps] embeddings <endpoint> down: ...`.

### When it is down

- **Recall** falls back to keyword search. The first failure is logged at error level
  (`Semantic search failed; falling back to keyword search only`), then every 50th. When the
  service answers again, egirl logs `Semantic search recovered` and goes back to hybrid search.
- **Memories saved meanwhile** are stored without an embedding, with a warning each time.
  Nothing adds one later, so those memories are found only by keyword from then on.
- **The duplicate check** for auto-extracted memories is skipped, so near-duplicates can be
  stored.

### Changing the model or the dimensions

Stored vectors keep the model and the size they were made with. `dimensions` is not checked
against what the server returns.

- **A different size** (say, 2048 to 768): every search that compares vectors fails with
  `Vector dimension mismatch`. Recall falls back to keyword search, as if the service were
  down. Auto-extracted memories are worse off: the duplicate check throws, so each one is
  dropped with a `Failed to store extracted memory` warning. Memories saved with `memory_set`
  are stored.
- **The same size, another model**: nothing fails, but old and new vectors come from different
  models, so their similarity scores mean nothing.

Nothing re-embeds old memories. To start clean, stop egirl and clear the old vectors. The
memories and their keyword index stay; only the vectors go:

```bash
sqlite3 ~/.egirl/workspace/memory.db "UPDATE memories SET embedding = NULL"
```

New memories get vectors from the new model. Old ones are found by keyword only.

## Code agent

**What it adds.** The `code_agent` tool. The operator writes the prompt, a code agent does the
engineering, and the permission supervisor answers its permission requests. See
[code-agent.md](code-agent.md).

**Without it.** No `code_agent` tool. The operator still has the shell, files, git and the web.

| `provider` | Needs |
|------------|-------|
| `claude` | Claude Code signed in on this machine (`claude login`). Runs through the Claude Agent SDK, which egirl installs |
| `codex` | The `codex` CLI on `PATH` (or `EGIRL_CODEX_BIN`), signed in |
| `opencode` | The `opencode` CLI on `PATH`, with its own provider login |
| `acp` | Any Agent Client Protocol agent, named in `acp_command`. See [acp.md](acp.md) |

egirl needs no API key for any of them. Codex, opencode and ACP agents start with a cleaned
environment (no `*API_KEY*`, `*TOKEN*` or `*SECRET*` variables), so they rely on their own stored
login.

```toml
[tools]
code_agent = true

[channels.code_agent]
provider = "claude"
permission_mode = "default"          # requests go to the permission supervisor
# providers = ["codex", "claude"]    # fallback chain
# working_dir = "~/projects/myrepo"
```

**Doctor and startup.**

- `doctor` prints `code agent tool`, `code agent config` and `<binary> cli` (whether `claude`,
  `codex`, `opencode` or the first word of `acp_command` is on `PATH`). It checks only
  `provider`, not a `providers` chain, and it doesn't check logins.
- With PR #259 or later, an unconfigured code agent is `skip` when `[tools] code_agent` is off, and
  `warn` when it's on with no `[channels.code_agent]`. Only a configured provider whose CLI isn't on
  `PATH` is `fail`. Before #259, the unconfigured case showed as `fail`.
- At startup, `[tools] code_agent = true` with no `[channels.code_agent]` logs a warning, and the
  tool is not registered.

**When it is missing or broken.** The tool is still offered; a call returns
`Code agent error: ...`. With `providers = [...]`, egirl tries the next backend only when this
one could not run at all:

- a missing binary
- a failed start
- a 401 or 403, or an expired login
- an exhausted quota or a rate limit
- empty output

An agent that ran and reported failure is not retried.

## Web search (SearXNG)

**What it adds.** The `web_search` tool, through a [SearXNG](https://docs.searxng.org)
instance's JSON API.

**Without it.** `web_search` is not registered. There is no other search backend. Startup logs
`[tools] web_search = true but no [searxng] url is configured`. Set `[tools] web_search = false`
to silence it. `web_research` (fetching and reading a URL) needs no service and works either
way.

**How to run it.** Any SearXNG instance, with the JSON format enabled under `search.formats` in
its `settings.yml`.

```toml
[searxng]
url = "http://localhost:8888"
```

If your instance requires a key, set `SEARXNG_API_KEY` in `.env`. egirl sends it as a bearer
token.

**Doctor and startup.** Neither checks SearXNG.

**When it is down.** Each call returns an error: `Failed to query SearxNG: ...`, or a timeout
after 15 seconds. An HTTP 403 or 404 adds a hint that the JSON format is off.

## MCP servers

**What it adds.** Tools from any [MCP](https://modelcontextprotocol.io) server, named
`<server>_<tool>`. See [mcp.md](mcp.md).

**Without it.** No extra tools.

```toml
[[mcp.servers]]
name = "fs"
command = "npx"                     # stdio: egirl spawns it
args = ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/notes"]

[[mcp.servers]]
name = "witchgrid"
url = "http://witchgrid.lan:8765/mcp"   # streamable HTTP
headers = { Authorization = "Bearer $WITCHGRID_SHARED_SECRET" }
```

`$VAR` in `env` and `headers` is read from the environment, so tokens can stay in `.env`.

**Doctor and startup.** Doctor sends a GET to each URL server. Any answer counts as `ok`, except
401 or 403, which fails with "check the Authorization header". Stdio servers show
`stdio (not probed)`. With PR #259 or later, a URL server that is down also gets a `[deps]`
warning at startup.

**When it is down.** egirl connects to every server at startup. A server that fails to spawn or
connect is logged (`Could not connect to '<name>'`), and its tools are skipped for the life of
the process. The other servers and egirl's own tools are not affected. There is no reconnect;
restart egirl once the server is back. A call that fails after connecting returns
`MCP call to <server>.<tool> failed: ...`.

## Auxiliary model

**What it adds.** A second model for side work: compaction summaries and memory extraction. Side
work runs on every compaction and every few turns. On the operator, it takes the operator's slot
and context while it runs. The permission supervisor always uses the operator.

**Without it.** Side work runs on the operator. This is the default, and it is fine for most
setups.

**When to add one.** For slot or context pressure: the operator is slow to share, or long tasks
compact often. Choose the model for extraction quality, not just summarization.

In replays of egirl's extraction prompt on the transcript of a task that did nothing:

| Model | Runs that wrote junk memories |
|-------|-------------------------------|
| The operator (B6-27B) | 0 of 11 |
| A small summarization-tuned model (Qwen3.5-4B + LoRA), thinking on | 2–3 of 5, and often ran out of its 1024-token budget mid-reasoning |
| The same model, thinking off | 5 of 5 |

A model that summarizes well can still write junk memories. Check yours on extraction before you
rely on it. When in doubt, don't configure one.

```toml
[local.auxiliary]
endpoint = "http://localhost:8215"   # defaults to the operator's endpoint
model = "qwen3-4b"
# max_concurrent = 1
# temperature = 0                    # the default for side work
```

The auxiliary endpoint is sent no API key and no `hosted` handling, so it has to be a llama-server
that needs no key. It is ignored when `[local] provider = "claude"`.

A thinking model forces a trade-off. For summaries, thinking has to be off at the server: with it on, a
capped call can spend its whole budget thinking and return nothing
([deployment.md](deployment.md)). But with thinking off, the summarization-tuned model in the
table above wrote junk memories in every run. The same auxiliary serves both jobs, and extraction
can't be routed separately yet. So a model like that is a good compactor and a bad extractor. If
memory quality matters, leave the auxiliary unset and let the operator do the side work.

**Doctor and startup.** Doctor shows an `auxiliary model` line, from `GET {endpoint}/v1/models`.
With PR #259 or later, a down auxiliary also gets a `[deps]` warning at startup.

**When it is down** (egirl newer than PR #258): side work falls back to the operator. egirl logs
one warning naming the endpoint, retries the auxiliary every 60 seconds, and logs again when it
answers. Before PR #258, side work failed quietly: summaries degraded to a crude extraction, and
memory extraction returned nothing.

## Other dependencies

| What | Needs | Without it |
|------|-------|------------|
| Browser tools (`[tools] browser = true`) | Playwright's Chromium: `bunx playwright install chromium` | The tools are offered, but the first one used fails to launch the browser. Doctor doesn't check |
| `screenshot` | `grim`, `scrot`, `maim` or `gnome-screenshot`, and an operator that accepts images | Unset, the tool is offered only when the server's `/props` reports vision. Without a capture program, a call fails and names the programs to install |
| `run_code` (`[tools] run_code = true`) | Linux, `bwrap` with unprivileged user namespaces, and the language's interpreter | Startup warning; the tool is not registered |
| GitHub tools (`[tools] github = true`) | `GITHUB_TOKEN` in `.env`. `[github]` is optional | Startup warning; the tools are not registered |
| `consult` | `[[consultants]]`, with the key in `EGIRL_CONSULTANT_<NAME>_KEY`. egirl posts to `{endpoint}/chat/completions`, so include `/v1` in `endpoint` | No `consult` tool, silently |
| Peers | `[[peers]]`, and another egirl's API. Token in `EGIRL_PEER_<NAME>_TOKEN` ([peers.md](peers.md)) | No peer tools, silently. A down peer returns an error to the call |
| HTTP API | `[channels.api]` | Doctor's `api port` line warns when the port is already bound |
| Witchgrid | `[local.witchgrid]` | If the control plane can't be reached, startup fails, unless `[local] endpoint` is set explicitly ([configuration.md](configuration.md#localwitchgrid)) |
| Chat channels | A token in `.env` and a `[channels.*]` block each ([configuration.md](configuration.md)) | Not started |
