#!/usr/bin/env python3
"""Turn ladder transcripts into training rows.

A ladder run leaves two things per task: the scorecard entry in results/<label>.json (passed,
strategy, diff, turns) and the transcript in transcripts/<label>/<task>.jsonl, one line per model
round trip with the exact messages and tools the provider sent. The last line's messages plus its
response is the whole trajectory, in the OpenAI shape egirl now sends, so a row rendered through
the model's chat template reproduces the prompt the model saw.

Two outputs, both JSONL:

  --sft    one {"messages", "tools"} row per run that passed cleanly. "Cleanly" is the filter
           set from the B2 plan: verify passed, no stranded tool call or truncated turn anywhere
           in the run, no recovery reissue or nudge, no edits under a test path, within the turn budget,
           and a final message that reports -- a run that passed but never wrote a final message
           is not a finished trajectory.
  --pairs  one {"prompt", "chosen", "rejected", "tools", "kind"} row per task that has both a
           clean pass and a failure across the given labels. Kinds: pass/fail, delegate/self-flail
           (the pass escalated, the failure ground alone), honest/claimed (the failure's final
           message asserts success). ORPO material.

Usage:
    python3 render_sft.py --label ablate-b1.1-native --label ladder-b0-9b --sft b2_sft.jsonl --pairs b2_pairs.jsonl
    python3 render_sft.py --dir ~/Projects/egirl-other/bench/ladder --label x --sft out.jsonl
"""

import argparse
import json
import re
import sys
from pathlib import Path

TEST_PATH_RE = re.compile(r"(^|/)(tests?|__tests__)/|(\.test\.[tj]sx?|_test\.py|test_[^/]*\.py)$")
CLAIM_RE = re.compile(
    r"\b(all|the|every)?\s*tests? (now )?pass(es|ed)?\b|\bpassing\b|\bdone\b|\bimplemented\b", re.I
)


def load_results(ladder: Path, label: str) -> dict[str, dict]:
    path = ladder / "results" / f"{label}.json"
    if not path.exists():
        sys.exit(f"no results for {label}: {path}")
    data = json.loads(path.read_text())
    return {r["id"]: r for r in data["results"]}


def load_transcript(ladder: Path, label: str, task_id: str) -> list[dict] | None:
    path = ladder / "transcripts" / label / f"{task_id}.jsonl"
    if not path.exists():
        return None
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return rows or None


def api_tool_call(call: dict) -> dict:
    return {
        "id": call["id"],
        "type": "function",
        "function": {"name": call["name"], "arguments": call["arguments"]},
    }


def api_message(msg: dict) -> dict:
    out = {"role": msg["role"], "content": msg.get("content", "")}
    if msg.get("tool_calls"):
        out["tool_calls"] = [api_tool_call(c) for c in msg["tool_calls"]]
    if msg.get("tool_call_id"):
        out["tool_call_id"] = msg["tool_call_id"]
    return out


def api_tools(tools: list[dict]) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["parameters"],
            },
        }
        for t in tools
    ]


def trajectory(turns: list[dict]) -> tuple[list[dict], list[dict]]:
    """Messages of the whole run, ending with the final response as an assistant turn."""
    last = turns[-1]
    messages = [api_message(m) for m in last["messages"]]
    resp = last["response"]
    final = {"role": "assistant", "content": resp.get("content", "")}
    if resp.get("tool_calls"):
        final["tool_calls"] = [api_tool_call(c) for c in resp["tool_calls"]]
    messages.append(final)
    return messages, api_tools(last["tools"])


def touches_tests(diff: str) -> bool:
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            path = line.split(" b/")[-1]
            if TEST_PATH_RE.search(path):
                return True
    return False


def reject_reason(result: dict, turns: list[dict], max_turns: int) -> str | None:
    """Why a run is not a clean trajectory, or None if it is."""
    if not result.get("agent_ok", True):
        return "agent crashed"
    if len(turns) > max_turns:
        return f"{len(turns)} turns > budget {max_turns}"
    for t in turns:
        resp = t["response"]
        if resp.get("finish_reason") == "length":
            return "truncated turn"
        if "<tool_call>" in (resp.get("content") or ""):
            return "stranded tool call"
    # Ephemeral recovery turns are dropped from the transcript, so a reissue shows up as a turn
    # whose context did not grow by the previous turn's call and result.
    for prev, cur in zip(turns, turns[1:]):
        if len(cur["messages"]) <= len(prev["messages"]):
            return "recovery turn (context did not grow)"
    if touches_tests(result.get("diff") or ""):
        return "edited tests"
    # A one-shot run has exactly one real user turn, the task. Any later one is a nudge the loop
    # injected (loop warning, continuation prompt), i.e. the model needed steering to finish.
    if sum(1 for m in turns[-1]["messages"] if m["role"] == "user") > 1:
        return "nudged"
    last = turns[-1]["response"]
    if last.get("tool_calls"):
        return "ended mid-action"
    if not (last.get("content") or "").strip():
        return "no final report"
    return None


def claims_success(text: str) -> bool:
    return bool(CLAIM_RE.search(text or ""))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=Path, default=Path(__file__).resolve().parent,
                    help="ladder dir holding results/ and transcripts/")
    ap.add_argument("--label", action="append", required=True,
                    help="results/<label>.json + transcripts/<label>/ (repeatable)")
    ap.add_argument("--sft", type=Path, help="write clean passing trajectories here (JSONL)")
    ap.add_argument("--pairs", type=Path, help="write chosen/rejected pairs here (JSONL)")
    ap.add_argument("--max-turns", type=int, default=24)
    ap.add_argument("--levels", help="comma-separated levels to keep, e.g. 1,2")
    args = ap.parse_args()
    levels = {int(x) for x in args.levels.split(",")} if args.levels else None

    sft_rows: list[dict] = []
    by_task: dict[str, dict[str, list[dict]]] = {}
    counts: dict[str, int] = {}
    seen: set[str] = set()

    def count(key: str) -> None:
        counts[key] = counts.get(key, 0) + 1

    for label in args.label:
        for task_id, result in load_results(args.dir, label).items():
            if levels and result.get("level") not in levels:
                continue
            turns = load_transcript(args.dir, label, task_id)
            if not turns:
                count("no transcript")
                continue
            messages, tools = trajectory(turns)
            entry = {
                "label": label,
                "task": task_id,
                "level": result.get("level"),
                "strategy": result.get("strategy"),
                "turns": len(turns),
                "messages": messages,
                "tools": tools,
                "final": messages[-1].get("content", ""),
            }
            slot = by_task.setdefault(task_id, {"pass": [], "fail": []})
            if not result.get("passed"):
                slot["fail"].append(entry)
                count("fail")
                continue
            reason = reject_reason(result, turns, args.max_turns)
            if reason:
                count(f"pass rejected: {reason}")
                continue
            key = json.dumps(messages, sort_keys=True)
            if key in seen:
                count("duplicate")
                continue
            seen.add(key)
            slot["pass"].append(entry)
            sft_rows.append(entry)
            count("clean pass")

    if args.sft:
        with args.sft.open("w") as f:
            for e in sft_rows:
                meta = {k: e[k] for k in ("label", "task", "level", "strategy", "turns")}
                f.write(json.dumps({"messages": e["messages"], "tools": e["tools"], "meta": meta}) + "\n")

    pair_count = 0
    if args.pairs:
        with args.pairs.open("w") as f:
            for task_id, slot in by_task.items():
                for good in slot["pass"]:
                    for bad in slot["fail"]:
                        # System + first user turn are identical across labels for one task, so
                        # that is the prompt and the pair diverges from the first assistant turn.
                        kinds = ["pass/fail"]
                        if good["strategy"] == "escalated" and bad["strategy"] == "self":
                            kinds.append("delegate/self-flail")
                        if claims_success(bad["final"]):
                            kinds.append("honest/claimed")
                        f.write(json.dumps({
                            "prompt": good["messages"][:2],
                            "chosen": good["messages"][2:],
                            "rejected": bad["messages"][2:],
                            "tools": good["tools"],
                            "kind": kinds,
                            "meta": {"task": task_id, "chosen_label": good["label"],
                                     "rejected_label": bad["label"]},
                        }) + "\n")
                        pair_count += 1

    for k in sorted(counts):
        print(f"{counts[k]:5d}  {k}")
    if args.sft:
        print(f"wrote {len(sft_rows)} sft rows -> {args.sft}")
    if args.pairs:
        print(f"wrote {pair_count} pairs -> {args.pairs}")


if __name__ == "__main__":
    main()
