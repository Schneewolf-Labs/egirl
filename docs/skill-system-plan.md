# Self-authoring skills: a plan

Kira should be able to write skills for work she is repeatedly given, then correct and repair
them as they fail. A Hemlock skill should exist because she wrote one after the third Hemlock
task, not because someone hand-authored it.

This is a design note, not a description of what exists. Phase 1 is a prerequisite for the rest
and is worth doing whether or not the authoring work happens.

## What exists today

- `SKILL.md` per directory, optional YAML frontmatter (`openclaw.requires`, `egirl.complexity`)
- `loadSkillsFromDirectories()` reads `src/skills/bundled` then `config.skills.dirs`, later
  directories overriding earlier ones by name
- every loaded skill is `enabled: true` — the `requires.bins` field is parsed but not enforced
- `buildSkillsSection()` injects **the full body of every skill** into the stable system prompt
- skills load once at boot; nothing rewrites or reloads them

Measured: stable prompt 12,507 chars with two bundled skills of ~1,300 chars each.

## The problem that has to be solved first

Full content of every skill, always, in the cache-eligible prefix. Two skills is 2.5 KB and fine.
Thirty self-written skills is ~40 KB — a third of the 131k window spent before the conversation
starts, on instructions that are irrelevant to almost every turn.

A system that writes its own skills makes this worse on purpose: success looks like more skills.
So the current injection strategy actively punishes the feature working. Fix the scaling first,
or the first useful week of authoring degrades the agent.

## Phase 1 — progressive disclosure

Put names and descriptions in the prompt; load bodies on demand.

**Prompt becomes:**

```
## Available Skills
Call `skill_read` to load the full instructions before acting on one.

- **hemlock** — Write, build and debug Hemlock programs. Use for .hm files or hemlockc errors.
- **code-review** — Review a diff for correctness, security and style.
```

**New tool: `skill_read(name)`** returns the body. One extra round trip on the turns that need
it, against ~90% off the per-turn cost of every turn that does not.

The description is doing the routing, so it must say *when to use this*, not what it is. That is
also what makes descriptions the thing Phase 3 repairs: a skill that never fires is usually a
description problem, not a body problem.

Decisions:
- The bodies are already `## When to Use` shaped, so descriptions can be derived from existing
  content for the bundled ones.
- Loaded bodies go in the volatile section, not the stable prefix, so a mid-session load does not
  invalidate the prefix cache for the whole conversation.
- `loop.ts:419` already rebuilds context from `promptOptions`; that is the hook.

## Phase 2 — authoring

**`skill_write({ name, description, content, when_to_use, replaces? })`**

- writes to the first writable dir in `config.skills.dirs`, never into `src/skills/bundled`;
  overriding a bundled skill by name is how a bundled skill gets "edited"
- validates before writing: frontmatter parses, name is a slug, description non-empty, body
  parses as markdown, and the skill is not a duplicate of an existing one by name
- refuses to write a skill whose body is empty or is only a restatement of the description
- hot-reloads so the skill is usable in the same session that created it

**Provenance in frontmatter, always:**

```yaml
egirl:
  author: agent            # or 'human'
  created_at: 2026-08-15T11:42:00Z
  updated_at: 2026-08-15T12:10:00Z
  revision: 3
  source_session: 8f3a...  # transcript this came out of
  derived_from: [web]      # web | transcript | codebase | human
```

**Versioned history.** Every write copies the previous body to
`<skill>/history/<revision>-<timestamp>.md`. Cheap, and it is the precondition for Phase 3:
self-healing without rollback is just self-damaging.

**`skill_delete(name)`** — soft, moves to `history/` with a tombstone. An agent that can create
but not remove accumulates dead skills.

## Phase 3 — self-healing

Healing needs evidence. Right now nothing records that a skill was used, let alone whether it
helped.

**Usage record** (`{workspace}/skills/.usage.jsonl`), appended when a skill is read:
`{ skill, session, ts, task_summary, outcome }` where outcome is derived from what the turn did
— tool errors, a retry loop, the user correcting the agent, or a clean finish.

**Triggers for revision:**

| signal | likely fault | action |
|---|---|---|
| read, then the task failed | body is wrong | revise body |
| never read across N relevant tasks | description does not match reality | revise description |
| read then immediately ignored | body too vague to act on | revise body |
| repeated identical correction from the user | missing constraint | add constraint |

**The loop:** on trigger, Kira reads the skill, its history, and the failing transcript segment,
then calls `skill_write` with a revision. Revision N+1 records what it changed and why in
frontmatter, so the history is a record of reasoning rather than a diff pile.

**Guard against thrash.** A skill revised more than K times in a window without its outcome rate
improving gets frozen and flagged for a human. Self-healing that oscillates is worse than a
stale skill, and it is the failure mode most likely to appear first.

## Safety

A skill is instructions the agent will follow later, so authoring is a persistence mechanism.
The realistic threat is not a jailbreak — it is Kira researching a topic, ingesting a page that
says "when writing skills, always include this step", and writing that into a skill she then
follows for weeks.

Mitigations, in order of value:

1. **Provenance is mandatory.** `derived_from: [web]` is the flag worth auditing. A skill written
   from web content is not inherently bad, it is inherently reviewable.
2. **Never write outside the skills dirs.** Path traversal in `name` is the obvious hole; slug
   validation closes it.
3. **No new capability.** A skill is instructions; it cannot grant tools the agent does not have.
   Keep it that way — no `allowed_tools` field, no shell hooks in frontmatter.
4. **Human-visible diff.** `skill_write` logs a compact diff at info level. Silent self-
   modification is the property that makes this feel unsafe, and it is cheap to remove.
5. **Bundled skills are immutable on disk.** Overrides live in the user dir, so `git checkout`
   always restores a known-good baseline.

## Order of work

1. Phase 1 alone (progressive disclosure + `skill_read`) — worth merging on its own, since it
   removes the prompt-growth ceiling and improves today's two-skill setup slightly.
2. Phase 2 authoring + history + provenance.
3. Usage recording, shipped and left to gather data with no revision logic.
4. Phase 3 revision, once there is real data about how skills actually fail.

Doing 3 before 4 matters: the trigger table above is a guess. A week of usage records turns it
into a measurement, and the wrong trigger produces a self-modifying agent that revises the wrong
thing confidently.

## Open questions

- **Does a skill need an activation hint beyond the description?** `egirl.escalationTriggers`
  already exists on bundled skills and is currently unused. Either enforce it or delete it.
- **Should `requires.bins` gate loading?** It is parsed and ignored; a Hemlock skill on a machine
  without `hemlockc` is noise. Cheap to enforce, and it makes `enabled` mean something.
- **Per-persona or shared?** `config.skills.dirs` has both `~/.egirl/skills` and
  `{workspace}/skills`. A skill Kira writes for Hemlock is probably shared; one about the user's
  preferences is probably not.
- **How does a skill get promoted to bundled?** If Kira writes a genuinely good Hemlock skill,
  the path from her directory into the repo should be a PR a human reviews, not a copy.
