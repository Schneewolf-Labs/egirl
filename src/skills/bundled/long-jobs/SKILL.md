---
openclaw:
  emoji: "⏳"
---

# Run Long Jobs

Use when a command takes minutes or longer (test suites, builds, benchmarks, CI, releases): start it so it survives, prove it's running, poll on a bound, and read the result before reporting.

## When to Use

Activate for any command that may outlast one tool call or one delegated session: a full test suite,
a build, a benchmark, a model download, a CI run, a release workflow.

## Instructions

1. **Foreground if it fits.** If the command finishes inside the tool's timeout, run it in the
   foreground with a `timeout` of its own. Background jobs fail in quieter ways.
2. **Background so it survives:** redirect all output to a file and record the exit code, e.g.
   `nohup bash -c 'cmd > /tmp/job.log 2>&1; echo "rc=$?" >> /tmp/job.log' &`. Jobs started inside a
   delegated agent's session can die when that session ends. Don't rely on them.
3. **Prove it's running** before you say so: its PID exists, and its log or output is growing. A
   process with no children, no open connections and an empty log is probably hung, not working.
4. **Poll on a bound.** Use a loop with a sleep and a maximum number of tries, and print the state
   each time. Never wait without a limit.
5. **Read the end of the log and the exit code,** not just "the process is gone". A job that was
   killed leaves a short log with no `rc=` line.
6. **CI:** pin the exact commit (`gh run list --commit <sha>`), wait until every job finishes, and
   read failing logs. "Mostly green" isn't green. A step that fails before your code runs (installing
   a toolchain, say) isn't your change's failure, but say so with the log line.
7. **Don't trust "I'll be notified".** If a tool says a job continues in the background, check it
   yourself later. Nobody may be watching it.
8. **Shared machines:** a slow or flaky test during a long run may be load from other jobs. Re-run that
   test alone before blaming your change, and say what you did.

## Output Format

- **Command:** what ran, and where its log is.
- **Result:** exit code and the summary lines from the log (counts, durations).
- **Anything re-run,** and why.
