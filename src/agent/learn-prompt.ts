/**
 * `/learn` -- turn whatever the user described into a saved, reusable skill.
 *
 * Ported from hermes-agent's learn_prompt.py, keeping its central design decision: there is
 * no distillation engine and no new tool. This builds ONE prompt and the live agent does the
 * work with the tools it already has -- reading files, fetching what it can, mining the
 * current conversation -- and authors the skill by writing a SKILL.md into the skills
 * directory. That is also why it works identically over the CLI and the web console: both
 * just run a turn.
 *
 * The closing of the loop is what this buys: an agent that walked through a gnarly workflow
 * once (the RFH header dance, the llama-server restart ritual) can be told "/learn what we
 * just did" and the next session starts with it as a skill instead of a memory.
 */

/**
 * Build the instruction for an open-ended `/learn` request.
 *
 * @param userRequest free text after `/learn` -- paths, URLs, "what we just did", pasted
 *   notes, and any requirements about scope or angle. Empty means "distill this conversation".
 * @param skillsDir directory the skill must be written into (first entry of `[skills] dirs`,
 *   expanded). Named explicitly in the prompt so the model does not guess a location.
 */
export function buildLearnPrompt(userRequest: string, skillsDir: string): string {
  const req =
    userRequest.trim() ||
    'the workflow we just went through in this conversation — review the steps taken and distill them into a reusable skill'

  return (
    `[/learn] The user wants you to learn a reusable skill from the request below, and save it.\n\n` +
    `THE REQUEST:\n${req}\n\n` +
    `The request is open-ended and may mix two kinds of content, in any order: SOURCES to ` +
    `gather (directories, file paths, URLs, "what we just did", pasted notes) AND REQUIREMENTS ` +
    `that shape the skill (what to focus on, what to leave out, scope, naming, the angle to ` +
    `take). Treat EVERY part of the request as load-bearing. Prose that comes after a path is ` +
    `NOT incidental — it is the user telling you what they want from that source. Never gather ` +
    `the first source and ignore the rest.\n\n` +
    `Do this:\n` +
    `1. Inventory every source the user named, using the tools you already have — read_file ` +
    `and execute_command for local files and directories, and the current conversation if they ` +
    `referred to something you just did. For a large source, inspect enough to map its major ` +
    `topics; do not load a whole corpus into context.\n` +
    `2. Distill PROCEDURE, not narration: the steps that would let you (or another agent) redo ` +
    `this without rediscovering it. Include the exact commands, paths, gotchas and checks that ` +
    `made the difference. Leave out dead ends unless knowing the dead end IS the lesson — then ` +
    `record it as a warning.\n` +
    `3. Choose a short kebab-case skill name (e.g. "rfh-header-parsing") and write the skill to ` +
    `${skillsDir}/<name>/SKILL.md with this shape:\n` +
    `   - optional YAML frontmatter between --- fences (only if you need metadata)\n` +
    `   - a single "# Title" heading\n` +
    `   - one paragraph right under the heading saying what the skill does (this becomes its ` +
    `description in the skill list)\n` +
    `   - "## When to Use" — the situations that should trigger it\n` +
    `   - "## Instructions" — the distilled procedure\n` +
    `4. If a skill with substantially this purpose already exists in ${skillsDir}, improve that ` +
    `file instead of creating a near-duplicate.\n` +
    `5. Finish by telling the user the skill's name, where you wrote it, and a one-line summary ` +
    `of what it covers. Note that it loads on the next restart.\n\n` +
    `Honor every requirement in the request while doing the above.`
  )
}
