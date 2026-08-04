#!/usr/bin/env bash
# Build throwaway repos for the bench to work on.
#
# The delegate/inspect/git/trivial cases need a real project to act on, and they originally
# pointed at ~/Projects/egirl itself. That was a mistake with teeth: asked to "migrate the config
# format across all files", the agent rewrote egirl.example.toml into an invented format and
# deleted 117 lines; asked to profile the embedding lookup, it changed the service's default port
# out from under egirl.toml and then reported work it had not done. None of that was a model
# failure — an agent with write access to a live repo will use it, and the harness was what let it.
#
# So the bench gets its own copies under ~/Projects/dummy, restored before every run. They are
# real repos with real history (cloned from the originals) so the tasks stay realistic, but
# nothing here is anyone's working tree.
#
# Usage:
#   bench/sandbox.sh init     clone/refresh the sandboxes
#   bench/sandbox.sh reset    restore all sandboxes to their pristine branch
set -euo pipefail

DUMMY="${EGIRL_BENCH_SANDBOX:-$HOME/Projects/dummy}"
SRC_EGIRL="$HOME/Projects/egirl"

init() {
  mkdir -p "$DUMMY"
  if [ ! -d "$DUMMY/egirl/.git" ]; then
    echo "cloning egirl -> $DUMMY/egirl"
    git clone -q "$SRC_EGIRL" "$DUMMY/egirl"
  fi
  # A dedicated branch makes "pristine" unambiguous: reset goes back to bench-baseline, and the
  # branch cannot be confused with work in the source repo.
  git -C "$DUMMY/egirl" checkout -q -B bench-baseline
  git -C "$DUMMY/egirl" add -A
  git -C "$DUMMY/egirl" -c user.email=bench@local -c user.name=bench \
      commit -q -m "bench baseline" --allow-empty
  echo "sandbox ready: $DUMMY/egirl (branch bench-baseline)"
}

reset_all() {
  for repo in "$DUMMY"/*/; do
    [ -d "$repo/.git" ] || continue
    git -C "$repo" checkout -q -- . 2>/dev/null || true
    git -C "$repo" clean -fdq 2>/dev/null || true
  done
}

case "${1:-init}" in
  init) init ;;
  reset) reset_all; echo "sandboxes reset" ;;
  *) echo "usage: $0 [init|reset]"; exit 2 ;;
esac
