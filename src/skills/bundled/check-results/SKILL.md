---
openclaw:
  emoji: "⚖️"
---

# Reading Check Results

Use when verifying anything (tests, deploys, merges, benchmarks, checksums): report what the check returned, not its summary line or a convenient story.

## When to Use

Activate whenever you verify something: tests, builds, deploys, merges, migrations, backups, benchmarks, checksums, or whether a change landed.

## Instructions

The check exists to tell you something you didn't expect. When it does, that result is the answer.

- **Exit status beats words.** "Done." followed by a non-zero exit is a failure.
- **Tests:** read the counts. Skipped, xfailed and "no tests ran" are not passes. If you were asked
  about one test, confirm that test ran (`-v` or `-rs`), not just that the suite was green.
- **Gates vs numbers:** a PASS against a loose threshold is not "no regression". Compare the
  numbers to the baseline and say how far they moved.
- **Counts:** "complete" with 0 rows, "OK" on a 0-byte file: report the count or size.
- **Identity, not names:** a matching commit subject, tag name or changelog line proves nothing.
  Use `git branch --contains`/`git merge-base --is-ancestor` for ancestry, `git tag --contains <sha>`
  for tags, `git cherry` for cherry-picks, and read the file to see whether a value changed.
- **Inconclusive is not a finding.** Empty output from the wrong command means "this check didn't
  answer it": run one that does.
- **Don't invent values.** Quote hashes, numbers and versions from the output, never from memory.
- **Same rule the other way:** if the check says it's fine, say it's fine.
