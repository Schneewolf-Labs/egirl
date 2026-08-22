# Deployment

How to stand up the serving stack an egirl instance actually needs, and how to
duplicate a running instance onto a second box. Every command here is from a real
multi-box deployment — the "Zero" reverse-engineering instance running across two
hosts. Ports (8080/8083/8215) are the ones that deployment used; substitute your
own.

For the config keys these commands map to, see
[docs/configuration.md](configuration.md). To install the tooling, see
[scripts/setup-tools.sh](../scripts/setup-tools.sh). For the sandbox, see
[services/vm/README.md](../services/vm/README.md).

## The Serving Stack

An instance needs three model services. The topology that worked is **operator on
GPU, embeddings and compactor on CPU** — one box, fully self-sufficient. The two
CPU services stay off the operator's GPU slot so side work never competes with the
model doing the actual thinking.

```
  ┌─────────────────────── one box ───────────────────────┐
  │                                                        │
  │   operator   27B, GPU        llama-server :8080        │
  │   embeddings Qwen3-VL-2B, CPU serve-embedding.py :8083 │
  │   compactor  4B, CPU         llama-server :8215        │
  │                                                        │
  └────────────────────────────────────────────────────────┘
```

Install everything with the bundles in
[scripts/setup-tools.sh](../scripts/setup-tools.sh):

```bash
scripts/setup-tools.sh base embeddings model-serving
```

### 1. Operator (GPU) — the model egirl drives

llama.cpp serving a 27B on the GPU. Exact launch:

```bash
llama-server -m <model>.gguf -ngl 99 -c 163840 \
  -ctk q4_0 -ctv q4_0 -np 1 -fa on --jinja \
  --host 0.0.0.0 --port 8080
```

Config — point `[local]` at it:

```toml
[local]
endpoint = "http://<host>:8080"
model = "qwen3-27b"
context_length = 65536   # see "Sizing the context" below — NOT the server's -c
```

#### The KV-cache tradeoff: big context OR fast decode, not both

The `-ctk q4_0 -ctv q4_0` quantized KV cache is what lets a **164k context fit on a
48GB card**. It is not free: it roughly **halves** prompt-eval and decode speed
(measured ~17–23 tok/s decode). `f16` KV is ~1.6× faster but needs a smaller `-c`
to fit the same card. Pick the axis that matters for the workload:

| KV cache | Context on 48GB | Decode speed |
|----------|-----------------|--------------|
| `q4_0`   | up to ~164k     | ~17–23 tok/s |
| `f16`    | smaller `-c`    | ~1.6× faster |

#### Sizing the context: a smaller window the model engages with wins

Real incident: with `context_length` set to the full 164k window, at ~77%
utilization (~126k tokens) the model started **drowning** — it would reload the
huge context, emit a summary with **no tool calls**, end the run after a single
inference, then sit idle. Dropping `context_length` to ~64k restored productive
multi-turn work: compaction summarizes the overflow, and NOTES.md + memory carry
continuity across the boundary.

Rule of thumb: **a smaller working window the model actually engages with beats a
huge one it drowns in.** You can serve a large `-c` for headroom while setting
`context_length` well below it — they are different numbers and the second is the
one that governs how the agent behaves.

#### If the operator endpoint is shared or keyed

If you start llama.cpp with `--api-key` (e.g. one operator serving several
instances over a LAN), egirl authenticates with `Authorization: Bearer`. Prefer
the env var so the secret stays out of the TOML:

```bash
export EGIRL_LOCAL_API_KEY=your-key      # preferred
```

```toml
[local]
# api_key = "your-key"                   # works, but keep secrets out of the toml
```

### 2. Embeddings (CPU) — memory

egirl's `embedding-server/serve-embedding.py`, model
`Qwen/Qwen3-VL-Embedding-2B`, 2048-dim, `/embed` route. **CPU only** —
`device_map="cpu"` is baked in, so it never touches the operator's GPU.

Install the CPU-torch venv (CPU wheels avoid a multi-GB CUDA download the server
would never use):

```bash
scripts/setup-tools.sh embeddings
# equivalently:
python3 -m venv ~/embed-venv
~/embed-venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
~/embed-venv/bin/pip install transformers accelerate 'uvicorn[standard]' fastapi Pillow pydantic requests
```

Launch (default `--host 0.0.0.0 --port 8083`):

```bash
bun run embeddings
# or directly:
~/embed-venv/bin/python embedding-server/serve-embedding.py --host 0.0.0.0 --port 8083
```

Config:

```toml
[local.embeddings]
provider = "qwen3-vl"
endpoint = "http://<host>:8083"
model = "qwen3-vl-embedding-2b"
dimensions = 2048
```

### 3. Compactor / auxiliary (CPU) — side work off the operator's slot

A small model on CPU (`-ngl 0`) handling compaction summaries and memory
extraction. These run on every compaction and every few turns; keeping them on a
separate CPU endpoint means they never occupy the operator's slot or compete for
its context. Exact launch:

```bash
llama-server -m ReAligned-Qwen3.5-4B-Q8_0.gguf \
  --lora-scaled compactor-lora-f16.gguf:1.0 \
  -c 65536 -np 2 --jinja -ngl 0 \
  --host 0.0.0.0 --port 8215
```

Config — point `[local.auxiliary]` at it:

```toml
[local.auxiliary]
endpoint = "http://<host>:8215"
model = "reoriented-qwen3.5-4b"
```

## Where to Run It: VM vs. Bare-Metal

The choice is about the **failure mode of the work**, not convenience.

- **KVM VM** (`services/vm/provision.sh`, needs libvirt) — use it when the instance
  **executes untrusted binaries**: reverse engineering, unknown binaries,
  untrusted repos. There the failure mode is "the host is gone," and the boundary
  has to be *below* the agent. egirl's in-process `command_filter`, `path_sandbox`,
  and permission supervisor are guardrails, **not a security boundary** — the model
  can be argued past them, and a binary the agent runs ignores them entirely. See
  [services/vm/README.md](../services/vm/README.md) for provisioning, snapshots,
  and the file-drop.
- **Bare-metal** — fine for safer work (coding, ops, research). Just know the same
  guardrails are not a sandbox; if the work could go hostile, use the VM.

What makes the VM cheap for egirl: the operator model runs over HTTP on another
host, so the guest needs only an IP — **no GPU passthrough**, the usual pain of
agent VMs.

## Duplicating an Instance to Another Box

Moving "Zero" from one host (`sabre`) to a second (`merlin`) split cleanly into
**static assets you pre-stage** and **dynamic state you sync at cutover**.

### 1. Pre-stage the static, heavy assets (ahead of time)

These are large and don't change during a run, so copy them early:

- the model GGUFs (operator + compactor)
- for an RE instance: the Ghidra zip and her pre-analyzed Ghidra project, and the
  target binary
- anything else big and immutable the instance depends on

Provision the new box's tooling while you're at it:

```bash
scripts/setup-tools.sh base re-toolbox embeddings model-serving
```

Bring up the serving stack on the new box (operator/embeddings/compactor as above)
so its local ports are live before cutover.

### 2. Sync the dynamic state (at cutover)

The state that changes as the instance works — copy this last, at the moment you
switch over:

- the persona's `NOTES.md` and its `work/` artifacts
- the SQLite DBs: **conversations, tasks, memory**

### 3. Drop in a retargeted config

Replace `egirl.toml` on the new box with one whose endpoints point at **the new
box's local ports** (operator → its `:8080`, embeddings → its `:8083`, compactor →
its `:8215`). Everything else — persona, tools, safety — carries over unchanged.

Relay files host-to-host as needed (scp, or the VM file-drop for getting assets
into a guest). Once the static assets are pre-staged, cutover is just: sync the
dynamic state, swap the config, start the instance.

Run `--instance <name> doctor` on the new box before enabling anything — it checks
the whole dependency graph (operator endpoint and what it's actually serving,
auxiliary model, embeddings, MCP servers, API port) in one shot.
