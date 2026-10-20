# Familiar: egirl as a model

Kira works alongside you, Zero disappears into a binary, and Emma answers the questions they can't. Familiar is
different from all three: it isn't anyone's agent. It's egirl dressed as an ordinary chat model.

Clients talk to it through the OpenAI API (`POST /v1/chat/completions`). Behind the API, egirl runs its agent loop
with three tools: web search, page reading and a calculator. The client gets back one answer. A small local model
that checks recent facts and works out arithmetic before it answers is a better model than its weights alone, and
from the outside it is just a model.

There are two editions, one process each:

| model id | weights | role |
|---|---|---|
| `familiar-spark` | a 9B | fast, cheap, runs anywhere |
| `familiar-ember` | a 27B | the stronger one |

## Files

- `IDENTITY.md`, `SOUL.md`, `AGENTS.md` are loaded into every prompt. SOUL carries the principles in
  short form, and AGENTS carries the tool-use rules.
- `CONSTITUTION.md` is the long form: what Familiar is for, its priorities, and how it behaves when there's
  a choice to make. It isn't loaded into the prompt; it's the reference that the prompt files, training
  data and evals are written against.
- `egirl.example.toml` configures a locked-down, stateless instance per edition.

## Running it

```bash
mkdir -p ~/.egirl/familiar/workspace
cp IDENTITY.md SOUL.md AGENTS.md ~/.egirl/familiar/workspace/
cp egirl.example.toml ~/.egirl/familiar/egirl.toml      # set the llama-server endpoints and SearXNG url
echo "EGIRL_API_TOKEN=$(openssl rand -hex 24)" > ~/.egirl/familiar/.env && chmod 600 ~/.egirl/familiar/.env

# Bun only auto-loads .env from the working directory (the egirl checkout), so load this one explicitly
set -a; . ~/.egirl/familiar/.env; set +a
EGIRL_CONFIG=~/.egirl/familiar/egirl.toml bun run start --instance familiar-spark api
```

```bash
curl -s http://127.0.0.1:3101/v1/chat/completions \
  -H "Authorization: Bearer $EGIRL_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"familiar-spark","messages":[{"role":"user","content":"What is the latest llama.cpp release?"}]}'
```

The config lives in its own directory on purpose. egirl merges `egirl.d/*.toml` from beside the main config,
and a fragment can't unset `[local.embeddings]`, so sharing a directory with another instance could give every
caller a shared memory.

## What it is not

- **Not stateful.** Each request is a fresh session, and nothing reaches memory.
- **Not the client's tool runner.** Requests that send `tools` are rejected, because Familiar runs its own.
- **Not public on its own.** The API has a single bearer token and no rate limits, so put a gateway in front
  of it that owns keys, quotas and logging (see [docs/public-instance.md](../../../docs/public-instance.md)).
