---
openclaw:
  requires:
    bins: ["git"]
  emoji: "🔍"
egirl:
  complexity: "remote"
  canEscalate: true
  escalationTriggers: ["review", "code review", "PR review", "check this code"]
  command:
    name: review
    description: Review a pull request or diff against current main
    args: PR number or URL (or nothing, for the local diff)
---

# Code Review

Use when reviewing a pull request or diff: check its state against current main, read the code rather than the description, run the tests.

## When to Use

Activate when asked to review code, a diff or a pull request, or to say whether something is ready to merge.

## Instructions

The PR description is the author's intent, not evidence. Every claim in your review points at a
file:line you read or a command you ran.

1. **State first.** For a PR: `gh pr view N --json mergeable,mergeStateStatus,headRefName,baseRefName`,
   then in the clone `git fetch origin` and `git fetch origin pull/N/head:pr-N`.
2. **What has main done since?** `git log --oneline pr-N..origin/main`. For each file the PR touches,
   `git log --oneline $(git merge-base origin/main pr-N)..origin/main -- <file>`. A conflict, or main
   having changed, replaced or superseded the same code, is the first line of the review.
3. **Read the diff and the code around it:** `git diff origin/main...pr-N`. Check each claim in the
   description against the code: holds, partly, or no.
4. **Look for:** bugs (logic, edge cases, error handling), security (paths, injection, secrets,
   untrusted input), tests that cannot fail (a test that returns instead of asserting), behaviour
   changes for existing users that the description doesn't mention.
5. **Run the tests** on the PR branch. Say what you ran and what it printed.

## Output Format

- **Verdict:** merge / changes needed / close, in one line. "Merge as-is" requires no conflicts,
  passing tests and no open issues below.
- **State:** mergeable or not, and what main changed since.
- **Issues:** critical first, each with file:line and a concrete fix.
- **Claims check:** the description's claims that don't hold.

Skip empty sections. Don't pad with praise.
