#!/usr/bin/env python3
"""Generate ladder tasks mechanically from any Python repo that has tests.

Hand-writing tasks does not scale, and the ladder needs volume for the thing it is actually for:
rejection-sampling successful trajectories into training data. One in five tasks produced a
tried-then-escalated-then-passed episode, so a useful collection needs hundreds of tasks, not five.

The trick is that a tested codebase already contains its own answer key. Replace a function body
with `raise NotImplementedError`, and "did the agent restore the behaviour" is answered exactly by
the suite that was already passing. No hand-written checks, no judge, and the difficulty is
whatever the original author's code happened to be.

    for each function f in the repo:
        blank f's body
        confirm the suite now FAILS      (or f is untested and the task is unverifiable)
        emit task: "implement f", verify = the repo's own test command
        restore

Difficulty is estimated from the body that was removed — lines, branches, whether it touches other
modules — which is coarse but enough to sort tasks into levels rather than guess at them.

Two honest limitations, neither fatal but both worth knowing:

  * A model can read the tests and special-case them instead of implementing the function. That is
    the same reward-hacking vector as anywhere else in this repo, and the mitigation is the same:
    it inflates scores rather than corrupting the fixture, and it shows up as an implementation
    that passes while looking nothing like the original. `--holdout` blanks a *second* test file
    and checks against that instead, which is the real fix when a repo has enough tests for it.
  * A function whose removal breaks import time (decorators, module-level use) produces a task
    where everything fails for the wrong reason. Those are detected by requiring that the suite
    fails with a *test* failure rather than a collection error, and skipped.

Usage:
    python3 gen_tasks.py --repo ../fixture --test-cmd "python3 -m unittest discover -s tests -q"
    python3 gen_tasks.py --repo /path/to/repo --test-cmd "pytest -q" --out generated_tasks.json
"""

import argparse
import ast
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def find_functions(repo: Path):
    """Every top-level function and method, with the source span of its body."""
    out = []
    for py in sorted(repo.rglob("*.py")):
        if any(p in py.parts for p in ("tests", "test", ".git", "__pycache__")):
            continue
        try:
            tree = ast.parse(py.read_text())
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if node.name.startswith("__"):
                continue
            body = [n for n in node.body if not isinstance(n, ast.Expr) or not isinstance(getattr(n, "value", None), ast.Constant)]
            if not body:
                continue
            start = body[0].lineno
            end = max(getattr(n, "end_lineno", n.lineno) for n in body)
            out.append({
                "file": str(py.relative_to(repo)),
                "name": node.name,
                "start": start,
                "end": end,
                "lines": end - start + 1,
                "branches": sum(isinstance(n, (ast.If, ast.For, ast.While, ast.Try)) for n in ast.walk(node)),
                "args": [a.arg for a in node.args.args],
            })
    return out


def blank_body(repo: Path, fn: dict) -> str:
    """Replace the function body with NotImplementedError. Returns the original text."""
    path = repo / fn["file"]
    original = path.read_text()
    lines = original.splitlines(keepends=True)
    indent = re.match(r"\s*", lines[fn["start"] - 1]).group(0)
    replacement = f'{indent}raise NotImplementedError("implement {fn["name"]}")\n'
    path.write_text("".join(lines[: fn["start"] - 1]) + replacement + "".join(lines[fn["end"]:]))
    return original


def run_tests(repo: Path, cmd: str, timeout=180):
    try:
        p = subprocess.run(cmd, shell=True, cwd=repo, capture_output=True, timeout=timeout, executable="/bin/bash")
        return p.returncode, (p.stderr + p.stdout).decode(errors="replace")
    except subprocess.TimeoutExpired:
        return 124, "timeout"


def level_for(fn: dict) -> int:
    """Coarse difficulty from the removed body. Not clever, just monotone and reproducible."""
    score = fn["lines"] + 2 * fn["branches"]
    return 1 if score <= 3 else 2 if score <= 8 else 3 if score <= 16 else 4 if score <= 30 else 5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--test-cmd", required=True)
    ap.add_argument("--out", default="generated_tasks.json")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    src = Path(args.repo).resolve()
    # Work on a copy: generation blanks bodies repeatedly and a crash mid-run must not leave the
    # source repo mutilated. The bench learned this the expensive way.
    tmp = Path(tempfile.mkdtemp(prefix="gentasks-"))
    repo = tmp / src.name
    shutil.copytree(src, repo, ignore=shutil.ignore_patterns("__pycache__", ".git"))

    rc, _ = run_tests(repo, args.test_cmd)
    if rc != 0:
        print(f"baseline suite does not pass (rc={rc}) — fix that first", file=sys.stderr)
        sys.exit(1)

    fns = find_functions(repo)
    if args.limit:
        fns = fns[: args.limit]
    print(f"{len(fns)} candidate functions", file=sys.stderr)

    tasks, skipped = [], {"still_passes": 0, "import_error": 0}
    for fn in fns:
        original = blank_body(repo, fn)
        rc, output = run_tests(repo, args.test_cmd)
        (repo / fn["file"]).write_text(original)

        if rc == 0:
            # Nothing exercises this function; restoring it is unverifiable.
            skipped["still_passes"] += 1
            continue
        if re.search(r"(ImportError|ModuleNotFoundError|SyntaxError|during collection)", output):
            skipped["import_error"] += 1
            continue

        lvl = level_for(fn)
        tasks.append({
            "id": f"gen_{fn['file'].replace('/', '_').replace('.py', '')}_{fn['name']}",
            "level": lvl,
            "source_file": fn["file"],
            "function": fn["name"],
            "blank_lines": fn["lines"],
            "prompt": (
                f"In the Python project at {{dir}}, the function `{fn['name']}` in `{fn['file']}` "
                f"has been removed — its body now raises NotImplementedError. Implement it so the "
                f"existing test suite passes. Do not modify the tests."
            ),
            "verify": args.test_cmd,
        })

    shutil.rmtree(tmp, ignore_errors=True)
    out = {
        "_comment": (
            "Generated by gen_tasks.py. Each task blanks one function body; the repo's own test "
            "suite is the check. Tasks whose removal left the suite green are dropped as "
            "unverifiable, and those that broke import are dropped as failing for the wrong reason."
        ),
        "tasks": tasks,
    }
    Path(args.out).write_text(json.dumps(out, indent=1))
    by_level = {}
    for t in tasks:
        by_level[t["level"]] = by_level.get(t["level"], 0) + 1
    print(f"kept {len(tasks)} tasks  {dict(sorted(by_level.items()))}", file=sys.stderr)
    print(f"skipped: {skipped}", file=sys.stderr)
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
