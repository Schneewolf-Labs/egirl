#!/usr/bin/env python3
"""Generate ladder tasks from egirl's own history: every fix that shipped with a test.

bench/selfwork.sh does this for one commit by hand. The ladder needs volume, and the repo has it:
of the last 400 commits, 149 touch both src/ and a test file. Each one is a task with ground truth
already attached — revert the source half, keep the test half, and the test the commit added is
the spec. The suite decides, not a diff comparison, so a different fix that passes is still a pass.

    for each non-merge commit c touching src/ and test/**/*.test.ts:
        check out c, confirm the commit's tests PASS      (else the sandbox cannot run that era)
        revert the src/ side to c^, confirm they FAIL     (else the tests do not pin the fix)
        emit task: "make these tests pass", setup = that revert, verify = those tests

Tasks come out in the same shape gen_tasks.py produces, so bench/ladder/run.ts runs them unchanged
with --repo pointed at the sandbox clone. The sandbox is the only place these may run: setup does
`git checkout -f`, which is exactly what must never happen to a working tree.

The commit subject rides along as the task description. That is what the human would have typed,
and it sometimes names the fix outright — fine; the test still has to pass.

The recipe is not egirl-specific: any repo whose commits pair a source change with a test that
can be run on its own qualifies. PROFILES names the source dirs, the test-file pattern and the
command that runs a subset of tests; the git side is the same everywhere.

Usage:
    python3 gen_selfwork.py --repo ~/Projects/dummy/egirl --ref github/main --out tasks_selfwork.json
    python3 gen_selfwork.py --profile hemlock --repo ~/Projects/dummy/hemlock --limit 600 --out tasks_hemlock.json
"""

import argparse
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

PROFILES = {
    "egirl": {
        "src": ("src/",),
        "test_re": re.compile(r"^test/.*\.test\.ts$"),
        # {tests} is the space-joined list of test files; the command runs in the repo root.
        "check": "bun test {tests}",
        "id": "selfwork",
        "describe": "the TypeScript project at {dir} (Bun)",
        "how": "run `bun test {tests}` to see how",
        "fix": "Fix the implementation under src/ so they pass.",
    },
    "grimoire": {
        "src": ("grimoire/",),
        "test_re": re.compile(r"^tests/test_.*\.py$"),
        # TestKbitPrepare fails on the installed peft regardless of the commit; it is not a spec.
        "check": "python3 -m pytest {tests} -q -x -p no:cacheprovider --deselect tests/test_trainer.py::TestKbitPrepare",
        "id": "grimoire",
        "describe": "the Python project at {dir}",
        "how": "run `python3 -m pytest {tests} -q` to see how",
        "fix": "Fix the implementation under grimoire/ so they pass.",
    },
    "hemlock": {
        "src": ("src/", "runtime/", "include/", "stdlib/"),
        # Interpreter tests (pass = exit code), compiler and parity tests (output must match the
        # .expected file next to them). Lint, formatter, contracts and check fixtures have their
        # own diagnostic runners and are left out. hemlock_check.sh knows all three rules.
        "test_re": re.compile(r"^tests/(?!contracts/|formatter/|lint/|check/).*\.hml$"),
        # {ladder} is filled in by run.ts, so the task file does not pin the checkout it was made from.
        "check": "bash {ladder}/hemlock_check.sh {tests}",
        "id": "hemlock",
        "describe": "the Hemlock language implementation at {dir} (C; build with `make`)",
        "how": (
            "run `make && ./hemlock <test>` to see (a test passes when it exits 0, except tests "
            "whose name contains overflow/negative/invalid/error, which must exit non-zero; "
            "tests under tests/compiler/ and tests/parity/ must instead produce exactly the "
            "output in the .expected file next to them, compiled with `./hemlockc <test> -o out` "
            "and, for parity, also interpreted)"
        ),
        "fix": "Fix the implementation under src/, runtime/ or stdlib/ so they pass.",
    },
}


def git(repo: Path, *args: str, timeout: int = 60) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, timeout=timeout
    ).stdout


def check_cmd(profile: dict, tests: list[str]) -> str:
    return profile["check"].replace("{tests}", " ".join(shlex.quote(t) for t in tests))


def run_check(repo: Path, profile: dict, tests: list[str], timeout: int = 240) -> int:
    try:
        return subprocess.run(
            check_cmd(profile, tests).replace("{ladder}", str(HERE)), shell=True, cwd=repo,
            capture_output=True, timeout=timeout, executable="/bin/bash",
        ).returncode
    except subprocess.TimeoutExpired:
        return 124


def changed_files(repo: Path, commit: str, profile: dict) -> tuple[list[str], list[str]]:
    files = git(repo, "show", "--name-only", "--format=", commit).split()
    src = [f for f in files if f.startswith(profile["src"])]
    return src, [f for f in files if profile["test_re"].match(f)]


def revert_command(repo: Path, commit: str, srcfiles: list[str]) -> str:
    """One bash line that puts the sandbox at `commit` with its src/ side undone."""
    parts = [f"git checkout -q -f {commit}"]
    for f in srcfiles:
        exists_before = subprocess.run(
            ["git", "cat-file", "-e", f"{commit}^:{f}"], cwd=repo, capture_output=True
        ).returncode == 0
        parts.append(
            f"git checkout -q {commit}^ -- {shlex.quote(f)}" if exists_before else f"rm -f {shlex.quote(f)}"
        )
    return " && ".join(parts)


def src_churn(repo: Path, commit: str, srcfiles: list[str]) -> int:
    stat = git(repo, "diff", "--numstat", f"{commit}^", commit, "--", *srcfiles)
    churn = 0
    for line in stat.splitlines():
        a, d, *_ = line.split("\t")
        if a.isdigit() and d.isdigit():
            churn += int(a) + int(d)
    return churn


def level_for(churn: int, srcfiles: list[str]) -> int:
    """Coarse difficulty from the size of the source change that was undone."""
    score = churn + 10 * (len(srcfiles) - 1)
    return 1 if score <= 8 else 2 if score <= 25 else 3 if score <= 60 else 4 if score <= 150 else 5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="sandbox clone; its working tree is overwritten")
    ap.add_argument("--profile", choices=sorted(PROFILES), default="egirl")
    ap.add_argument("--ref", default="HEAD")
    ap.add_argument("--out", default="tasks_selfwork.json")
    ap.add_argument("--limit", type=int, default=0)
    # A whole feature reverted to its tests ("Add Telegram channel", 900 lines) is not a task,
    # it is a rewrite with a spec. Keep the fixes.
    ap.add_argument("--max-churn", type=int, default=400, help="skip commits changing more src lines")
    args = ap.parse_args()
    profile = PROFILES[args.profile]

    repo = Path(args.repo).resolve()
    if not (repo / ".git").exists() or "dummy" not in repo.parts:
        sys.exit(f"refusing to run outside a sandbox under a 'dummy' directory: {repo}")

    commits = git(repo, "log", "--no-merges", "--format=%H %s", args.ref).splitlines()
    if args.limit:
        commits = commits[: args.limit]
    print(f"{len(commits)} commits on {args.ref}", file=sys.stderr)

    tasks, skipped = [], {"no_pair": 0, "too_big": 0, "baseline_fails": 0, "still_passes": 0}
    for line in commits:
        commit, _, subject = line.partition(" ")
        srcfiles, tests = changed_files(repo, commit, profile)
        if not srcfiles or not tests:
            skipped["no_pair"] += 1
            continue
        churn = src_churn(repo, commit, srcfiles)
        if churn > args.max_churn:
            skipped["too_big"] += 1
            continue

        git(repo, "checkout", "-q", "-f", commit)
        if run_check(repo, profile, tests) != 0:
            skipped["baseline_fails"] += 1
            continue

        setup = revert_command(repo, commit, srcfiles)
        subprocess.run(setup, shell=True, cwd=repo, capture_output=True, executable="/bin/bash")
        if run_check(repo, profile, tests) == 0:
            skipped["still_passes"] += 1
            continue

        short = commit[:10]
        test_list = " ".join(tests)
        tasks.append({
            "id": f"{profile['id']}_{short}",
            "level": level_for(churn, srcfiles),
            "commit": commit,
            "subject": subject,
            "src_churn": churn,
            "src_files": srcfiles,
            "tests": tests,
            "setup": setup,
            "prompt": (
                f"In {profile['describe']}, this task is open: \"{subject}\". "
                f"The tests for it are in {test_list} and currently fail — "
                f"{profile['how'].format(tests=test_list)}. {profile['fix']} "
                f"Do not modify the tests."
            ),
            # The spec files must come through untouched; a pass with an edited test is void.
            "verify": f"git diff --quiet -- {test_list} && {check_cmd(profile, tests)}",
        })
        print(f"  L{tasks[-1]['level']} {short} {subject[:60]}", file=sys.stderr)

    git(repo, "checkout", "-q", "-f", args.ref)
    out = {
        "_comment": (
            f"Generated by gen_selfwork.py --profile {args.profile} from the repo's own history. "
            "Each task reverts the source side of a commit that shipped with tests; those tests "
            "are the check. Runs only against the sandbox clone — setup does `git checkout -f`."
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
