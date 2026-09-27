# Shadow tutor

Training data for the local operator, labelled by a stronger model.

> Status: **shadow mode only.** The tutor watches and answers; nothing it says reaches the
> operator. Handhold mode, where a disagreement is fed back as a nudge, is not built.

## Why shadow, not "let the frontier model drive"

Pointing egirl at a frontier model and keeping its transcripts is plain distillation, and it
is off-policy: the frontier model never makes a 9B's mistakes, so the student learns moves it
can't follow up and never sees a recovery. The shadow tutor labels the states the **operator**
actually reaches. The operator keeps driving. On every turn the tutor gets the exact messages
and tools the operator got and answers them, and both answers go into the transcript. That is
DAgger: the states come from the student, the actions come from the expert.

It also keeps the data in the right distribution. The tutor sees egirl's real system prompt,
real tool schemas, and the context after compaction and nudges, so a row cut from it trains
the model on the harness it will actually run in.

## Running it

The tutor runs only on transcribed one-shot runs (`egirl cli -m ... --transcript <path>`),
which is what the ladder bench produces. Turn it on from the environment:

```sh
EGIRL_TUTOR_ENDPOINT=https://openrouter.ai/api \
EGIRL_TUTOR_MODEL=<vendor/model> \
EGIRL_TUTOR_API_KEY=... \
bun bench/ladder/run.ts --label tutored-9b
```

Or give it a permanent section in `egirl.toml`. The key still comes from `EGIRL_TUTOR_API_KEY`:

```toml
[tutor]
endpoint = "https://api.openai.com/v1"   # any OpenAI-compatible base; a trailing /v1 is fine
model = "..."
max_concurrent = 4                       # tutor requests in flight at once
timeout_ms = 600000                      # per labelled turn
# temperature = 0
```

Tutor calls run at the same time as the operator's next turn, so the run isn't slowed down.
A one-shot run waits for any outstanding labels before it exits. A run killed by the bench
timeout loses the labels that hadn't come back yet. Expect roughly double the token spend,
all on the tutor's bill.

## Transcript format

Each model turn line is unchanged. Each label is its own line, appended when it resolves:

```jsonc
{"turn": 3, "tutor": {"model": "...", "content": "...", "tool_calls": [...],
                      "finish_reason": "tool_calls", "usage": {...}, "ms": 2140}}
{"turn": 4, "tutor": {"model": "...", "content": "", "ms": 30000, "error": "..."}}
```

A failed tutor call is recorded with `error` and never fails the run.

## Rendering

`bench/ladder/render_sft.py` joins labels to turns by `turn`:

```sh
python3 bench/ladder/render_sft.py --label tutored-9b \
  --tutor-sft tutor_sft.jsonl --tutor-pairs tutor_pairs.jsonl
```

- `--tutor-sft`: one row per usable label. The row is that turn's prompt plus the tutor's
  answer. Labels that errored, truncated, came back empty, or called a tool the turn didn't
  offer are dropped. Rows come from failing runs too, since those are the states that most
  need an expert answer.
- `--tutor-pairs`: one row per turn where the tutor took a different action (different calls
  or arguments) than the operator. The tutor's answer is `chosen`, the operator's is
  `rejected`. Two plain-text answers are never paired, because prose always differs.

Each row's `meta` carries `run_passed` and `agrees` for filtering. **A tutor label is not
verified by execution.** Nothing ran the tutor's action, so its correctness is exactly as
good as the tutor. The ladder's checks grade the operator's trajectory, not the label.

## Hosted endpoints: what the operator provider sends

The tutor reuses the llama.cpp provider with two differences. It names the `model` in the
request, and it sends no thinking config and no cache slot. That keeps the request to plain
OpenAI fields.

Pointing `[local]` itself at a hosted API (frontier as operator) has not been tried live. From
reading the request path:

| Request detail | On a hosted API |
|---|---|
| no `model` field (the operator provider never sends it) | rejected by most hosted APIs |
| `chat_template_kwargs` whenever a thinking config reaches the provider | llama.cpp-only; strict APIs reject unknown fields |
| `cache_slot` / `id_slot` (`[local] cache_slots` defaults to 1) | same |
| `/tokenize` for context fitting | falls back to char-ratio estimates, with a warning |
| `/props` probe | 404, so the configured `context_length` stands |

Making that work would mean a `[local]` switch that sends the model and drops the llama.cpp
fields. It isn't built, because the shadow tutor covers the use case without making a
hosted model the operator.
