---
openclaw:
  emoji: "📦"
---

# Deliver Work

Use when a task ends in a file, commit, report or message: write it where asked, verify it landed, disclose gaps, and finish the work instead of listing next steps.

## When to Use

Activate for any long-running or background task whose result is an artifact: a written file,
a commit or push, a report, or a message sent to someone.

## Instructions

1. **Resolve the path before writing.** Use the exact path the user gave. Expand `~` to the
   home directory (`echo ~` or `$HOME`); never create a directory literally named `~`. A relative
   path means relative to the user's stated directory, not your workspace. If unsure, run
   `realpath <path>` and use the absolute result.
2. **Write with a tool, then check it.** Call `write_file` (or the command that produces the file).
   Then `ls -l <absolute path>` and `read_file` the first lines. No file, or 0 bytes, means not done.
3. **Commits:** after `git_commit`, record the hash with `git rev-parse HEAD`.
4. **Pushes:** after `git push`, run `git status -sb` (no `ahead N`) and
   `git ls-remote origin <branch>`; the remote hash must equal your local `HEAD`. A push that
   printed an error, or was rejected, is not pushed.
5. **Messages:** say sent only when the send tool returned success. Quote its error if it failed.
6. **Partial results are reported as partial.** If a rate limit, timeout or error stopped part of
   the work, say which items are missing and why. Never fill the gaps with zeros, blanks or guesses,
   and never drop the failed rows silently.
7. **Do the next step yourself.** If a step is yours, nothing blocks it and it was in scope, do it
   before you reply. List a step for the user only when it needs their decision, access or approval.
8. **Verify once, then move on.** A fact you checked stays checked. Don't re-run the same check or
   restate the same result; state it once in the final reply.

## Closing Checklist

Before the final reply, confirm each that applies:

- The file exists at the exact path asked for (`ls -l` or read back), with its size.
- The commit hash, from `git rev-parse HEAD`, not from memory.
- `git status -sb` shows nothing ahead, and `git ls-remote` matches `HEAD`.
- What is missing, failed or unverified, stated plainly in one place.
- The reply quotes the real absolute paths and hashes from the output above.
