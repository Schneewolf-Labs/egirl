---
openclaw:
  emoji: "🔎"
---

# Investigate an Anomaly

Use when output looks wrong or surprising (a too-good score, an odd diff, a strange reply): find the cheapest check that could prove your explanation wrong, run it, then report.

## When to Use

Activate when something doesn't add up: a pass rate that's too good, a diff smaller than the task,
a reply that cites facts nobody gave it, a test that passes locally and fails in CI, a process that
should be busy but isn't.

## Instructions

1. **Write the anomaly down exactly.** Quote the line, the number, the file. "It seems off" is not
   something you can test.
2. **List two or three explanations** before you believe one. Include the boring ones: you're reading
   the wrong file, the wrong run, the wrong field, or a stale copy.
3. **Pick the cheapest check that tells them apart,** and run it. Good checks:
   - re-run one case by hand and compare with the recorded result;
   - read the raw artifact (the request log, the JSON, the full diff), not a summary of it;
   - check what a value is measured against (a diff against `HEAD` hides a change that was
     reverted to `HEAD`);
   - run the same input through a known-good baseline.
4. **Expect to be wrong.** Your first explanation often is. If the check refutes it, say so plainly,
   drop it, and go to the next. A withdrawn hypothesis is a result.
5. **Narrow to a minimal repro** once you have a real finding: the smallest input or command that
   shows it every time. Save it to a file and give the exact command.
6. **Label every claim:** *verified* (you ran the check and read the output), *hypothesis* (plausible,
   not checked), or *unknown*. Never let a hypothesis turn into a fact between paragraphs.
7. **Time-box it.** If the anomaly doesn't affect the task, note it with what you checked and move on.
   Say when you're choosing to chase it anyway.

## Output Format

- **Finding:** one sentence, labelled verified or hypothesis.
- **Evidence:** the check you ran and what it printed.
- **Ruled out:** explanations you tested and dropped, one line each.
- **Repro:** the file and command, if there is one.
