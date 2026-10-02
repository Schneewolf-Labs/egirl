---
openclaw:
  requires:
    bins: ["git"]
  emoji: "🤝"
---

# Delegating to the Code Agent

Use when handing coding work to code_agent: write a scoped brief, judge its permission requests, verify its diff yourself, and report verified apart from claimed.

## When to Use

Activate whenever you call `code_agent`, when it asks for approval, and when it returns.

## Instructions

The agent's summary is a claim, not a result. You report what you checked.

1. **Write the brief.** It cannot see this conversation. Include:
   - **Goal:** the behaviour wanted, with the exact error or test name if there is one.
     "Fix the tests" is not a goal; "`test_parse_dates` fails with KeyError 'tz' since a1b2c3d; make it pass" is.
   - **Where:** set `working_dir` to the repo's absolute path; name the files or directory in scope.
   - **Constraints:** language version, no new dependencies, keep the public API, style rules.
   - **Done when:** the commands that must pass, e.g. `bun test src/parser` and `bun run lint`.
   - **Do not touch:** files, config, lockfiles, CI, other branches; no commits or pushes unless asked.
   Pass screenshots via `images`. Don't paste whole files you pre-read; give paths and let it read.
2. **Record the start state:** `git status` and `git rev-parse HEAD` before the call, so you can
   tell its changes from what was already there.
3. **Permission requests.** Read the exact command or path, then ask:
   - Is it inside the task's scope and `working_dir`?
   - Is it reversible? An edit in the repo is; `rm -rf`, `git push`, `reset --hard`, installs
     outside the project, writes to `~` or `/etc`, and reading secrets are not.
   - Would you run it yourself for this task?
   Yes to all: allow. Clearly out of scope or destructive: deny, with a reason it can act on
   ("don't edit the lockfile; pin the version in package.json instead"). Unsure or irreversible
   but needed: ask the user. Don't allow everything, and don't deny everything either.
4. **Verify what came back.**
   - `git status` and `git diff --stat`: every changed file should be in scope. Out-of-scope
     changes: revert them (`git checkout -- <file>`, only if it was clean at the start) or
     send it back, and say so.
   - Read the diff (`git diff`), not just the summary. Look for deleted or skipped tests,
     loosened assertions, `any`/ignore comments, hardcoded expected values.
   - Rerun the done-when commands yourself and read the counts. "All tests pass" from the agent
     doesn't count until your run says so.
5. **Not done?** Send a follow-up `code_agent` call with the failing output quoted, not a vaguer retry.

## Output Format

- **Changed:** files from `git diff --stat`, one line each on what changed.
- **Verified:** the commands you ran and what they printed.
- **Claimed, not verified:** anything from the agent's summary you didn't check, labelled as its claim.
- **Out of scope / reverted / open:** if any.
