#!/usr/bin/env python3
"""Blank one function body, so a generated task starts from the state its prompt describes.

gen_tasks.py works out *which* functions make verifiable tasks, but the task itself has to be
set up at run time: reset the repo, remove the function, then hand the agent the prompt. Without
this step the prompt claims a function "has been removed" while the implementation is still
sitting there, and the agent quite reasonably reports that everything already works — a task that
passes without the model doing anything is worse than one that fails.

Kept separate from gen_tasks.py so the runner can invoke it per task without importing anything.

Usage:
    python3 blank.py --repo /path/to/repo --file inventory/store.py --function add
"""

import argparse
import ast
import re
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--function", required=True)
    args = ap.parse_args()

    path = Path(args.repo) / args.file
    src = path.read_text()
    tree = ast.parse(src)

    target = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == args.function:
            # Skip docstrings so the signature and its documentation survive; only the logic goes.
            body = [
                n for n in node.body
                if not (isinstance(n, ast.Expr) and isinstance(getattr(n, "value", None), ast.Constant))
            ]
            if body:
                target = (body[0].lineno, max(getattr(n, "end_lineno", n.lineno) for n in body))
                break

    if target is None:
        print(f"function {args.function} not found in {args.file}", file=sys.stderr)
        sys.exit(1)

    start, end = target
    lines = src.splitlines(keepends=True)
    indent = re.match(r"\s*", lines[start - 1]).group(0)
    stub = f'{indent}raise NotImplementedError("implement {args.function}")\n'
    path.write_text("".join(lines[: start - 1]) + stub + "".join(lines[end:]))
    print(f"blanked {args.function} in {args.file} (lines {start}-{end})")


if __name__ == "__main__":
    main()
