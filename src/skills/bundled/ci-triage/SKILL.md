---
openclaw:
  requires:
    bins: ["git", "gh"]
  emoji: "🚦"
egirl:
  command:
    name: ci
    description: Triage CI for a PR, run or branch from the failing log, reproduce, fix and re-check
    args: PR number, run id or branch
---

# CI Triage

Use when CI is red or you're asked whether it's green: pin the exact commit, read every job and the failing log, reproduce, fix, and re-check the new run.

## When to Use

Activate when asked about CI status, a failing check or workflow run, or to fix a red build.

## Instructions

A job's name is not its cause, and one green job is not a green run. Every claim points at a run id,
a job and a log line.

1. **Pin the commit.** For a PR: `gh pr view N --json headRefOid,headRefName`. For a branch:
   `git ls-remote origin <branch>`. A run counts only if its `headSha` matches:
   `gh run list --commit <sha>` or `gh run view <id> --json headSha,status,conclusion`.
   A run for an older commit is stale; say so instead of reporting it.
2. **List every job.** `gh pr checks N`, or `gh run view <id> --json jobs --jq '.jobs[]|[.name,.status,.conclusion]'`.
   Wait until none is queued or in progress. Green means every job succeeded. Skipped and cancelled
   are not passes: name them.
3. **Read the failing log.** `gh run view <id> --log-failed`. Quote the first real error (the
   assertion, compiler error or exit code), not the last line, and note which OS and versions the job ran.
4. **Classify, with evidence:**
   - **Real failure:** the error points at code this commit changed. Find the file:line.
   - **Environment:** runner, network, registry, missing secret or tool version; quote the line that shows it.
   - **Flake:** only if the same job passed on this exact commit, or fails on main intermittently
     (`gh run list --branch main --workflow <file>`). A guess is not evidence.
5. **OS-only failures:** if it passes on one OS and fails on another, check first for: absolute
   paths built by string concatenation (on Windows `/tmp/x` has no drive letter), `\` vs `/`
   separators (use the language's path join, never hardcoded `/`), case-sensitive file names
   (passes on macOS/Windows, fails on Linux), CRLF line endings in fixtures or snapshots, shell
   syntax that only works in bash.
6. **Reproduce before fixing.** Run the failing command from the log locally, same test, same
   flags. If you can't reproduce it (other OS), say so and write down why you expect the fix to work.
7. **Fix, run the full checks locally, push.** Never mark a flake fixed by re-running until green:
   `gh run rerun --failed` is only for evidence that it's a flake, and the report says it was a re-run.
8. **Re-check the new run** for the new head sha (step 1 again). Done means that run is green on
   every job, not that the push succeeded.

## Output Format

- **Commit:** sha and run id checked.
- **Jobs:** each failing or skipped job, its OS, conclusion.
- **Cause:** the quoted log line and the classification with its evidence.
- **Fix:** what changed, what you ran locally, and the new run's result per job.
