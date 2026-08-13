#!/usr/bin/env bash
# How often does the model reach for web_search when it should?
#
# The failure this measures: asked about something it cannot know, the model answers from
# parametric memory with confident specifics instead of searching. That is the exact failure
# web_search exists to prevent, so "the tool is registered" is not the same as "the tool works".
#
# Sampling temperature is non-zero, and the operator bench established a ~19% run-to-run flip
# rate on this model, so a single run tells you nothing. Repeat and report a rate.
#
# The field is `tool_calls`, snake_case, as emitted by `cli --json`. Reading `toolCalls` here
# silently yields an empty list on every run, which reads as "the model never used a tool" —
# a wrong answer that looks exactly like a real finding. PARSE_FAIL below covers malformed
# output; a key typo produces no error at all, so the field name is worth stating.
#
# Usage: bench/search_rate.sh [reps]
set -uo pipefail
cd "$(dirname "$0")/.."

REPS="${1:-3}"

# Each prompt is something the model cannot answer correctly from weights alone: it postdates
# training, or it is inherently live. An honest answer requires a search or an admission.
PROMPTS=(
  "What is the latest Qwen model released? Search the web to check."
  "Look up what the current stable version of Bun is."
  "What did Anthropic announce most recently? Check online."
  "Find out today's date according to a news site."
)

total=0
searched=0
echo "prompt,rep,tools_called,searched"
for i in "${!PROMPTS[@]}"; do
  for r in $(seq 1 "$REPS"); do
    out=$(timeout 300 bun run src/index.ts cli -m "${PROMPTS[$i]}" --json 2>/dev/null)
    tools=$(printf '%s' "$out" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('|'.join(t.get('name','?') for t in d.get('tool_calls',[])) or 'none')
except Exception:
    print('PARSE_FAIL')
")
    hit=0
    case "$tools" in *web_search*|*web_research*) hit=1 ;; esac
    total=$((total + 1))
    searched=$((searched + hit))
    echo "$i,$r,$tools,$hit"
  done
done

echo
echo "searched in $searched/$total runs ($((100 * searched / total))%)"
