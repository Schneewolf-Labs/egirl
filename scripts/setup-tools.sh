#!/usr/bin/env bash
#
# setup-tools.sh — provision a box to host an egirl instance.
#
# A convenience wrapper around the installs that a real deployment needs, so
# standing up a new box is one command instead of hand-typing a page of apt/pip
# lines from memory. Nothing here is magic; every command is one you could run
# yourself. It exists so you don't have to.
#
# ASSUMPTIONS
#   - Debian/Ubuntu. Uses sudo + apt. On anything else, read the bundle you want
#     and run the equivalents by hand.
#   - Run it from inside the egirl checkout (the `base` bundle runs `bun install`
#     in the current directory).
#
# USAGE
#   scripts/setup-tools.sh <bundle> [<bundle> ...]
#
# Bundles are opt-in — nothing runs unless you name it. They are roughly
# idempotent (re-running is safe), but they are not transactional; if one dies
# partway, read the error and re-run.
#
#   base            bun, build tooling, and egirl's node deps
#   re-toolbox      reverse-engineering stack: wine(+32-bit), radare2, Java 21,
#                   a python RE venv, and pointers for Ghidra
#   embeddings      a CPU-torch venv for the memory embedding server
#   model-serving   notes/pointers for serving the operator + compactor models
#
# Example — a full RE host:
#   scripts/setup-tools.sh base re-toolbox embeddings model-serving
#
set -euo pipefail

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
note() { printf '    \033[2m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }

usage() {
  cat >&2 <<'EOF'
Usage: scripts/setup-tools.sh <bundle> [<bundle> ...]

Bundles:
  base            bun + build tooling + egirl node deps (run from the egirl checkout)
  re-toolbox      wine(+32-bit), radare2, Java 21, python RE venv, Ghidra pointers
  embeddings      CPU-torch venv for the memory embedding server
  model-serving   pointers + example launch commands for the operator/compactor

Bundles are opt-in and can be combined:
  scripts/setup-tools.sh base re-toolbox embeddings model-serving

Uses sudo/apt — Debian/Ubuntu only.
EOF
}

bundle_base() {
  log "base: bun, build tooling, egirl deps"

  if command -v bun >/dev/null 2>&1; then
    note "bun already installed ($(bun --version)); skipping installer"
  else
    curl -fsSL https://bun.sh/install | bash
    # bun installs to ~/.bun/bin; surface it for the rest of this run.
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
    note "bun installed; add ~/.bun/bin to PATH in your shell rc if it isn't already"
  fi

  sudo apt install -y git unzip build-essential python3-pip python3-venv python3-full file binutils xxd jq

  if [ -f package.json ]; then
    log "base: bun install (in $(pwd))"
    bun install
  else
    warn "no package.json here — run 'bun install' from inside the egirl checkout"
  fi
}

bundle_re_toolbox() {
  log "re-toolbox: reverse-engineering stack"

  log "wine (+ 32-bit) — for running Win32 target binaries and native oracles"
  sudo apt install -y wine
  sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install -y wine32:i386

  log "radare2 (from source — apt often has no candidate)"
  if command -v r2 >/dev/null 2>&1; then
    note "r2 already installed ($(r2 -v 2>/dev/null | head -1)); skipping"
  elif [ -d "$HOME/radare2" ]; then
    note "~/radare2 already cloned; run '~/radare2/sys/install.sh' to (re)install"
  else
    git clone https://github.com/radareorg/radare2 "$HOME/radare2"
    "$HOME/radare2/sys/install.sh"
  fi

  log "Java 21 — Ghidra 12 requires it"
  sudo apt install -y openjdk-21-jdk

  log "python RE venv (~/re-venv): pefile, capstone, construct"
  if [ -d "$HOME/re-venv" ]; then
    note "~/re-venv already exists; skipping venv creation"
  else
    python3 -m venv "$HOME/re-venv"
  fi
  "$HOME/re-venv/bin/pip" install pefile capstone construct

  cat <<'EOF'

    Ghidra is NOT installed by this script — it is a separate ~570MB
    download/unzip, not an apt package. Grab the release you want and unzip it:

        https://github.com/NationalSecurityAgency/ghidra/releases

    (Zero's deployment used Ghidra 12.1.3.) Ghidra 12 needs the Java 21 installed
    above. Headless analysis runs via <ghidra>/support/analyzeHeadless.

EOF
}

bundle_embeddings() {
  log "embeddings: CPU-torch venv for the memory embedding server"

  if [ -d "$HOME/embed-venv" ]; then
    note "~/embed-venv already exists; skipping venv creation"
  else
    python3 -m venv "$HOME/embed-venv"
  fi

  # CPU torch on purpose — the default CUDA wheels pull multiple GB the embedding
  # server (device_map="cpu") will never touch.
  "$HOME/embed-venv/bin/pip" install torch torchvision --index-url https://download.pytorch.org/whl/cpu
  "$HOME/embed-venv/bin/pip" install transformers accelerate 'uvicorn[standard]' fastapi Pillow pydantic requests

  cat <<'EOF'

    Launch the embedding server (model Qwen/Qwen3-VL-Embedding-2B, 2048-dim,
    CPU-only, /embed route, default port 8083):

        bun run embeddings
        # or directly:
        ~/embed-venv/bin/python embedding-server/serve-embedding.py --host 0.0.0.0 --port 8083

    egirl config:
        [local.embeddings]
        provider   = "qwen3-vl"
        endpoint   = "http://localhost:8083"
        model      = "qwen3-vl-embedding-2b"
        dimensions = 2048

EOF
}

bundle_model_serving() {
  log "model-serving: pointers for the operator (GPU) + compactor (CPU)"

  cat <<'EOF'

    This bundle documents rather than installs — build llama.cpp yourself from
    https://github.com/ggerganov/llama.cpp (a CUDA build for the operator GPU).
    Once llama-server is on PATH, the topology that worked was:

    OPERATOR  — the 27B egirl drives, on GPU. q4_0 KV cache is what lets a 164k
    context fit on a 48GB card; it roughly halves prompt-eval and decode (measured
    ~17-23 tok/s decode). f16 KV is ~1.6x faster but needs a smaller -c. Big
    context OR fast decode, not both.

        llama-server -m <model>.gguf -ngl 99 -c 163840 \
          -ctk q4_0 -ctv q4_0 -np 1 -fa on --jinja \
          --host 0.0.0.0 --port 8080

    COMPACTOR — a small aux model on CPU (-ngl 0), kept off the operator's slot.
    Handles compaction summaries + memory extraction.

        llama-server -m ReAligned-Qwen3.5-4B-Q8_0.gguf \
          --lora-scaled compactor-lora-f16.gguf:1.0 \
          -c 65536 -np 2 --jinja -ngl 0 \
          --host 0.0.0.0 --port 8215

    egirl config points [local] at the operator (8080) and [local.auxiliary] at
    the compactor (8215). If the operator endpoint is keyed (--api-key), set
    [local].api_key or, preferred, the EGIRL_LOCAL_API_KEY env var.

    See docs/deployment.md for the full stack and the context-sizing lesson.

EOF
}

main() {
  if [ "$#" -eq 0 ]; then
    usage
    exit 1
  fi

  for bundle in "$@"; do
    case "$bundle" in
      base)          bundle_base ;;
      re-toolbox)    bundle_re_toolbox ;;
      embeddings)    bundle_embeddings ;;
      model-serving) bundle_model_serving ;;
      -h|--help|help) usage; exit 0 ;;
      *)
        warn "unknown bundle: $bundle"
        usage
        exit 1
        ;;
    esac
  done

  log "done: ${*}"
}

main "$@"
