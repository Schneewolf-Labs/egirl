# Scenario harness

Drives a real egirl instance through a scripted multi-turn conversation and grades it on
artifacts: what egirl actually sent to the model (recorded by a proxy), DB rows, files. No
model ever grades another model's transcript.

## Running

```
bun bench/scenarios/run.ts --operator stub --reps 2
bun bench/scenarios/run.ts --operator local --upstream http://127.0.0.1:8195 --model <name> --reps 3
bun bench/scenarios/run.ts --only recall-trivial-gate --keep
```

| Flag | Default | Meaning |
|---|---|---|
| `--operator stub\|local` | `stub` | `stub`: the proxy answers every chat request with `ok.`. `local`: the proxy forwards to `--upstream` |
| `--upstream URL` | `http://127.0.0.1:8195` (local only) | The llama-server (or any OpenAI-compatible endpoint) to forward to |
| `--model NAME` | `stub` / `local` | Sent as `EGIRL_LOCAL_MODEL` |
| `--reps N` | `1` | Repetitions per scenario, each on a fresh instance |
| `--only a,b` | all | Scenario names to run |
| `--embeddings URL` | stub embedder | Forward embedding requests to a real embedding server instead |
| `--embed-dims N` | `256` (stub), `2048` (real) | Embedding width; must match the server behind `--embeddings` |
| `--turn-timeout MS` | 120 s stub, 900 s local | Per-turn HTTP timeout |
| `--label NAME` | operator / model | Prefix of the results file |
| `--keep` | off | Keep each rep's temp root and print its path in the results |

Output: a line per failing check while running, then one summary line per scenario
(`passes/reps`, plus per-check pass counts). The full record goes to
`results/<label>-<timestamp>.json`: per rep, every check's pass/fail and evidence string, and
each turn's reply text. Each rep's raw proxy log is copied next to it in
`results/<label>-<timestamp>/<scenario>-rep<n>.requests.jsonl`.

## What one rep does

1. A temp root with its own `home/`, `workspace/` and generated `egirl.toml`.
2. The recording proxy (`proxy.ts`) starts on a free port.
3. The scenario's `setup` runs against the instance's workspace before egirl starts (e.g.
   seeding memories through `MemoryManager`, using the same embedder egirl will use).
4. `bun --no-env-file src/index.ts api` starts from the temp root, with the proxy as its local
   endpoint. The runner waits for `GET /` to answer; one boot retry covers Bun's occasional
   startup stall.
5. Turns go to `POST /chat`, in one session (`api:scenario`) unless a turn names its own.
   Whatever the proxy records while a turn is in flight belongs to that turn.
6. The scenario's checks run against the recorded requests, DBs and files. Then egirl is
   killed, the proxy stopped, and the temp root deleted (unless `--keep`).

### Hermeticity

The instance never sees the real machine: `HOME` is the temp root's `home/`, so `~/.egirl`,
`~/.config/gh`, `~/.ssh` and `~/.codex` all resolve inside it. `EGIRL_CONFIG` names the
generated config, so neither the repo's `egirl.toml` nor any `egirl.d/` fragment directory is
read. The environment is an allowlist (`PATH`, locale, `TERM`, then the harness's own vars), so
`GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `SSH_AUTH_SOCK` and `EGIRL_*` from your shell
never get through. `--no-env-file` and the temp cwd mean Bun loads no `.env`. The safety path
sandbox is on and limited to the temp root.

The base config (`baseConfig` in `instance.ts`) follows `bench/ladder/egirl.bench.toml`:
thinking off, conversation persistence off, memory recall and extraction off, tasks, heartbeat
and discovery off, code agent, browser, GitHub, peers, consultants and web tools off, no skill
dirs. A scenario turns on only what it tests.

### The proxy

Every `POST /v1/chat/completions` body is appended to the JSONL log before it's answered.
Embedding requests are logged too (`kind: "embeddings"`), which tells you whether a turn's text
was even searched for. In upstream mode every request, other routes included, is forwarded and
streamed back untouched. In stub mode, chat gets a fixed reply as SSE or JSON, whichever was
asked for. `/v1/models` gets a one-model list, and `/props`, `/tokenize`, `/slots` get a 404,
which egirl takes as "not llama.cpp" and falls back to estimates.

The stub embedder is a hashed bag of words plus one shared component. That component gives two
texts with no words in common a cosine of `STUB_EMBED_BASELINE` (0.3), which mimics the
anisotropy of real embedding models. Without it, unrelated text would score 0, and recall
could never fire on a greeting, which is exactly the production behaviour scenarios need to
catch. For real similarity, pass `--embeddings`.

The proxy also runs on its own: `bun bench/scenarios/proxy.ts --log req.jsonl [--upstream URL]`.

## Scenarios

### `recall-trivial-gate`

Memory is on with `proactive_retrieval`. Setup seeds four heartbeat-junk memories, one of them
a `log:<date>:<n>` daily-log chunk. At boot, egirl's own log indexer adds another from the
seeding writes. Then five turns run in one session: `hey juno`, `yo yo`, the `/continue` prompt
(`CONTINUE_PROMPT`, imported from `src/session/commands.ts`), the control question
`what does the heartbeat check monitor?`, and `thanks!`.

- **no-recall** (the greetings, the continue prompt, `thanks!`): the operator request for that
  turn contains no `[Recalled memories` / `[Recalled context from memory` block among the
  messages that turn added. egirl leaves earlier recalls in history (for prefix-cache
  stability), so checking the whole request would blame `thanks!` for the control turn's
  recall.
- **control-recall**: the control turn's request *does* carry a recall block. This proves the
  check can fail and that recall works at all.

Expected on main today: `hey juno`, `yo yo` and the continue prompt fail, because none of them
match the anchored `TRIVIAL_RE`. `thanks!` and the control pass.

## Adding a scenario

1. Create `bench/scenarios/<name>.ts` exporting a `Scenario` (see `types.ts`):
   - `config(ctx)`: TOML as an object, deep-merged over the base. `ctx.embeddings` gives the
     endpoint and width to use if the scenario needs memory with embeddings.
   - `setup(ctx)` (optional): runs before egirl starts. `ctx.memory()` opens the instance's
     memory store, and `ctx.workspace` is there for seeding files.
   - `turns`: `{ text, session? }[]`.
   - `checks(ctx)`: returns `{ name, passed, evidence }[]`. Grade artifacts only:
     `ctx.turns[i].requests` (what the proxy recorded during that turn), `ctx.allRequests`,
     and DBs and files under `ctx.workspace`. Make the evidence the offending text, short
     enough to read in one line.
2. Add it to `SCENARIOS` in `run.ts`.
3. Include a control check that should pass. A check that never fails on any input proves
   nothing.

`checks.ts` has the helpers for picking a turn's operator request out of the log
(`operatorRequest`), scoping to what the turn added (`turnTail`), finding recall blocks
(`findRecall`) and asking whether the turn was embedded (`wasEmbedded`).

## Lint

The root `biome.json` only covers `src/` and `test/`. `bench/scenarios/biome.json` extends it
and includes this directory, so `bunx biome check bench/scenarios/` works.
