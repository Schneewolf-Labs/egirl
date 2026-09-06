#!/usr/bin/env bash
# Run a named subset of Hemlock's tests with the same pass rules as the repo's own runners, so
# the ladder can check one commit's tests in a second instead of the whole suite after a clean
# build. Three kinds, told apart by path:
#
#   tests/compiler/*.hml   compiled with hemlockc; output must equal the .expected file
#                          (tests/compiler/run_compiler_tests.sh)
#   tests/parity/**/*.hml  interpreted AND compiled; both outputs must equal .expected
#                          (tests/parity/run_parity_tests.sh)
#   tests/**/*.hml         interpreted; passes when it exits 0 — unless its name says it is an
#                          error test (overflow|negative|invalid|error, no "expect: pass" marker,
#                          outside stdlib_*), in which case it must exit non-zero
#                          (tests/run_tests.sh)
#
# Usage (from the hemlock checkout): bash hemlock_check.sh tests/arrays/concat.hml [...]
set -u
[ $# -gt 0 ] || { echo "usage: $0 <test.hml>..." >&2; exit 2; }

targets="hemlock stdlib"
for t in "$@"; do case "$t" in tests/compiler/*|tests/parity/*) targets="hemlock compiler stdlib";; esac; done
# shellcheck disable=SC2086
make -s -j16 $targets >/dev/null 2>&1 || { echo "build failed" >&2; make -s $targets 2>&1 | tail -20 >&2; exit 1; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

is_error_test() {
  [[ "$1" =~ stdlib_ ]] && return 1
  head -n 1 "$1" | grep -q "expect: pass" && return 1
  [[ "$1" =~ (overflow|negative|invalid|error) ]]
}

compiled_output() {
  local exe="$tmp/$(basename "$1" .hml)"
  ./hemlockc "$1" -o "$exe" >"$tmp/cc.log" 2>&1 || { echo "<compile failed: $(tail -1 "$tmp/cc.log")>"; return; }
  timeout 100 "$exe" 2>&1
}

fail=0
for t in "$@"; do
  case "$t" in
    tests/compiler/*|tests/parity/*)
      exp="${t%.hml}.expected"
      [ -f "$exp" ] || { echo "skip $t (no .expected)"; continue; }
      expected=$(cat "$exp")
      actual=$(compiled_output "$t")
      if [ "$actual" != "$expected" ]; then echo "FAIL $t (compiled output differs)"; fail=1; continue; fi
      if [[ "$t" == tests/parity/* ]]; then
        actual=$(timeout 100 ./hemlock "$t" 2>&1)
        if [ "$actual" != "$expected" ]; then echo "FAIL $t (interpreter output differs)"; fail=1; continue; fi
      fi
      echo "ok   $t"
      ;;
    *)
      timeout 100 ./hemlock "$t" >/dev/null 2>&1
      code=$?
      if is_error_test "$t"; then
        if [ "$code" -eq 0 ] || [ "$code" -gt 128 ]; then echo "FAIL $t (error test exited $code)"; fail=1; else echo "ok   $t (expected error)"; fi
      else
        if [ "$code" -ne 0 ]; then echo "FAIL $t (exit $code)"; fail=1; else echo "ok   $t"; fi
      fi
      ;;
  esac
done
exit $fail
