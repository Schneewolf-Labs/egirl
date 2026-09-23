#!/usr/bin/env bash
# Model-check every spec in this directory with TLC.
#
#   formal/check.sh path/to/tla2tools.jar
#
# Each <Spec>_<variant>.cfg is one model. Variants named for the code before a fix
# (buggy, concurrent, discord) are expected to FAIL with a counterexample; the rest are
# expected to pass. Exits non-zero when any model disagrees with its expectation.
set -u
jar="${1:?usage: formal/check.sh path/to/tla2tools.jar}"
cd "$(dirname "$0")"
meta="$(mktemp -d)"
trap 'rm -rf "$meta"; rm -f ./*_TTrace_*' EXIT

status=0
for cfg in *_*.cfg; do
  spec="${cfg%%_*}"
  variant="${cfg#*_}"; variant="${variant%.cfg}"
  case "$variant" in buggy|concurrent|discord) expect=fail ;; *) expect=pass ;; esac
  out="$(java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -nowarning -metadir "$meta/$cfg" -config "$cfg" "$spec" 2>&1)"
  if grep -q "No error has been found" <<<"$out"; then got=pass; else got=fail; fi
  why="$(grep -m1 -E '^Error: (Invariant|Deadlock|Temporal)' <<<"$out" || true)"
  if [ "$got" = "$expect" ]; then mark=ok; else mark=UNEXPECTED; status=1; fi
  printf '%-10s %-28s expected %-4s got %-4s %s\n' "$mark" "$cfg" "$expect" "$got" "$why"
done
exit $status
