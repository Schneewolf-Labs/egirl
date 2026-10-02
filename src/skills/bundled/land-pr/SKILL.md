---
openclaw:
  requires:
    bins: ["git", "gh"]
  emoji: "🛬"
egirl:
  command:
    name: land
    description: Update a PR with main, resolve conflicts, verify, and stop before merging
    args: PR number or URL
    permission: allowed
---

# Land a Pull Request

Use when updating, rebasing or merging a pull request: resolve conflicts from both sides' intent, verify, push, and stop for a go before merging.

## When to Use

Activate when asked to rebase, update, fix conflicts on, or merge a pull request.

## Instructions

1. **Clean tree first.** `git status`. If anything is modified or staged, look at it
   (`git diff --stat`, `git diff --cached --stat`) before you discard it. `reset --hard` is irreversible.
2. **Update the branch.** Check out the PR branch and `git merge origin/main` (or rebase if the
   repo prefers it; then push with `--force-with-lease`, never `--force`).
3. **Each conflict:** find the commit on each side that caused it
   (`git log --oneline -3 origin/main -- <file>`, then `git show <sha> -- <file>`, and the same on the
   PR side). Keep both intents. Never take one side wholesale. Check no markers remain:
   `git diff --check`.
4. **Full checks:** the repo's tests, lint and typecheck. All pass, or stop and report the failure.
5. **Push and wait for CI:** poll `gh pr checks N` until every check has finished.
6. **Stop before merging.** Merging lands on main and can't be taken back. Report the conflict
   causes, the resolved hunks verbatim, the check summaries and CI per check, and wait for a go.

Don't stop halfway with a list of next steps: if the next step is yours and nothing blocks it, do it.
