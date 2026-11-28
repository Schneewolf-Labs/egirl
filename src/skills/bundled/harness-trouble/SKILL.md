---
openclaw:
  emoji: "🩺"
egirl:
  command:
    name: diagnose
    description: Check egirl's own setup and dependencies, and report what's broken
---

# Diagnose the Harness

Use when egirl itself misbehaves (tools time out, approvals fail, memory acts odd, shell errors you didn't cause): check dependencies, tell harness bugs from your mistakes, report with a repro.

## When to Use

Activate when a tool fails in a way your command doesn't explain, when a delegated agent can't get
approvals, when memory or recall behaves strangely, or when asked whether the setup is healthy.

## Instructions

1. **Run `egirl doctor`** (with `--instance <name>` if there is one) and read every line. `fail` is
   broken, `warn` is worth a look, `skip` says why it didn't check. Startup also logs one `[deps]` line
   per configured dependency that's down.
2. **Know what degrades and what doesn't:**
   - no embeddings → keyword-only memory;
   - auxiliary model down → side work runs on the operator;
   - MCP server down → its tools are missing until restart;
   - operator down → nothing works.
   Don't report a degraded service as total failure, or the other way round.
3. **Your mistake or the harness's?** Re-run the smallest version of the failing call. If it fails the
   same way with an obviously correct input, it's the harness. Typical signs:
   - a safety block on a harmless command;
   - `/bin/sh` syntax errors on bash syntax;
   - permission requests failing with "stream closed";
   - a tool timing out at a fixed limit that has nothing to do with the work.
4. **Work around it openly.** If you work around a harness bug (run the step yourself, split the task,
   rephrase a command), say so in your reply, and say the workaround isn't the fix.
5. **Report it with a repro:** the exact call, the exact error, what you expected, and the egirl
   commit (`git log -1` in the egirl checkout). One small repro beats a long story.
6. **Check memory when recall looks wrong:** search for near-duplicate keys and for memories about
   how tasks work. They're often junk written by side work. See the memory-hygiene skill.
7. **Config changes apply at restart.** If you edit egirl's own config, say that a restart is needed.
   Don't assume it took effect.

## Output Format

- **Health:** the doctor summary, with each `fail`/`warn` line.
- **Harness bugs:** each with its repro and the egirl commit.
- **Workarounds in use:** what you did instead, and that it's temporary.
