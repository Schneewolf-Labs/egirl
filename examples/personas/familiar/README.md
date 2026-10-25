# Familiar: egirl as a model

Kira works alongside you, Zero disappears into a binary, and Emma answers the questions they can't. Familiar is
different from all three: it isn't anyone's agent. It's egirl dressed as an ordinary chat model.

Clients talk to it through the OpenAI API (`POST /v1/chat/completions`). Behind the API, egirl runs its agent loop
with four tools: web search, page reading, a calculator and a sandboxed Python interpreter (`run_code`). The
client gets back one answer. A small local model that checks recent facts and works out arithmetic before it
answers is a better model than its weights alone, and from the outside it is just a model.

There are two editions, one process each:

| model id | weights | role |
|---|---|---|
| `familiar-spark` | [B4-9B](https://huggingface.co/schneewolflabs/B4-9B) | fast, cheap, runs anywhere |
| `familiar-ember` | [B4-27B](https://huggingface.co/schneewolflabs/B4-27B) | the stronger one |

B4 is B2 trained on this instance's own API context to search and calculate before answering with thinking
off, the mode this config runs in. Other models work, but with thinking off they tend to answer current-info
questions and arithmetic from memory. B4 was trained with `[skills] bundled = false` and an empty `MEMORY.md`;
keep both so the prompt matches. `run_code` came after B4's training; B4 picks it up from the tool
description and these prompt files without further training.

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
: > ~/.egirl/familiar/workspace/MEMORY.md                # empty: no working-memory template in the prompt
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
