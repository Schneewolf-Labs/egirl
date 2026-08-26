import { join } from 'node:path'
import { AgentLoop } from '../agent/loop'
import type { RuntimeConfig } from '../config'
import type { MemoryManager } from '../memory'
import type { ChatMessage, LLMProvider } from '../providers/types'
import { createMemoryTools, createWorkingMemoryTool, globTool, readTool } from '../tools/builtin'
import { createSkillManageTool } from '../tools/builtin/skill-manage'
import { createToolExecutor } from '../tools/executor'
import { log } from '../util/logger'

/**
 * Post-run self-review — the autonomous half of the learn loop, ported from hermes-agent's
 * background review. After an unbounded task run completes, a restricted fork of the agent
 * reviews a digest of the run and updates skills and memory. The fork can ONLY touch skill
 * and memory tools (skill_manage runs as the "background" actor, so it may evolve
 * agent-created skills but never the user's), and its mutations all land in the skill
 * ledger, so anything it does is individually rollbackable.
 *
 * Fire-and-forget with a single-flight guard: a review never blocks the task pipeline, and
 * a slow review is skipped rather than stacked.
 */

const MAX_DIGEST_CHARS = 9000
const REVIEW_MAX_TURNS = 8

const REVIEW_PROMPT = `[Post-run self-review. You are reviewing the run you just completed — digest below. You have ONLY skill and memory tools this pass; your job is to make future runs better, then stop.

Step 1 — ALWAYS first: list the existing skills with glob_files (pattern "*/SKILL.md" in the skills directory) so you know what can be patched.

Step 2 — skills, in strict priority order (prefer the earliest that applies):
1. A skill you USED this run was wrong, incomplete, or missing a gotcha you hit → patch THAT skill (skill_manage action "patch"; read it first with read_file).
2. A procedure you developed or refined this run fits an EXISTING skill's purpose → patch that skill rather than creating a near-duplicate.
3. A genuinely NEW class of reusable procedure — a setup ritual, a verified command sequence, a debugging recipe you would need again — deserves a new skill, named for the CLASS of task ("wine-probe-capture"), never the session ("fix-ddraw-today").
Most runs that did real work justify at least one skill update: a missing gotcha, a new flag, a verified sequence. A procedure that lives only in notes gets re-derived every run; a skill gets reused. If you update no skill, state specifically why nothing qualified.

Step 3 — memory: durable facts, decisions-with-why, and lessons → memory_set. Facts that must be true EVERY session → working_memory.

Never capture: environment-dependent failures (if you found the fix, capture the FIX); "tool X doesn't work" from one failed attempt; an unresolved failure written up as a working procedure. Corrections from the user about style or approach ARE first-class skill/memory material. Do not invent updates to look busy — but do not file real procedures under memory when they belong in a skill.]

Run digest:
`

/** Compact role-labelled digest of a run's conversation: dialogue kept, tool payloads named only. */
export function digestRun(messages: ChatMessage[], maxChars: number = MAX_DIGEST_CHARS): string {
  const lines: string[] = []
  for (const msg of messages) {
    if (msg.role === 'system') continue
    if (msg.role === 'tool') continue
    const text = typeof msg.content === 'string' ? msg.content : ''
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      if (text.trim()) lines.push(`Assistant: ${text.slice(0, 300)}`)
      lines.push(`[tools: ${msg.tool_calls.map((c) => c.name).join(', ')}]`)
      continue
    }
    if (!text.trim()) continue
    lines.push(`${msg.role === 'user' ? 'User' : 'Assistant'}: ${text.slice(0, 400)}`)
  }
  const full = lines.join('\n')
  // Keep the tail — the end of a run is where conclusions and wrap-ups live.
  return full.length > maxChars ? `[...earlier turns omitted...]\n${full.slice(-maxChars)}` : full
}

const inFlight = new Set<string>()

export interface SelfReviewDeps {
  config: RuntimeConfig
  provider: LLMProvider
  memory?: MemoryManager
}

/**
 * Run the review pass for a completed task run. Resolves when the review finishes; callers
 * should fire-and-forget. Returns false when skipped (disabled, no skills dir, in flight).
 */
export async function runSelfReview(
  taskId: string,
  taskName: string,
  messages: ChatMessage[],
  deps: SelfReviewDeps,
): Promise<boolean> {
  const skillsDirs = deps.config.skills?.dirs ?? []
  if (skillsDirs.length === 0 || !deps.config.workspace?.path) return false
  if (inFlight.has(taskId)) {
    log.debug('self-review', `Skipping review for ${taskName}: previous review still running`)
    return false
  }

  const digest = digestRun(messages)
  if (digest.length < 200) return false // nothing happened worth reviewing

  inFlight.add(taskId)
  try {
    // Restricted toolset: reading plus skill/memory mutation, nothing else. The background
    // actor restriction on skill_manage is what keeps user-authored skills out of reach.
    const executor = createToolExecutor()
    const ledgerDir = join(deps.config.workspace.path, '.skill-ledger')
    executor.register(readTool)
    executor.register(globTool)
    executor.register(createSkillManageTool(skillsDirs, ledgerDir, { actor: 'background' }))
    executor.register(createWorkingMemoryTool(deps.config.workspace.path))
    if (deps.memory) {
      const mt = createMemoryTools(deps.memory)
      executor.registerAll([mt.memorySearchTool, mt.memorySetTool])
    }

    const agent = new AgentLoop({
      config: deps.config,
      toolExecutor: executor,
      localProvider: deps.provider,
      sessionId: `review:${taskId}`,
      additionalContext:
        'You are in a restricted post-run review pass: skill and memory tools only. Be brief and concrete.',
    })

    const response = await agent.run(REVIEW_PROMPT + digest, { maxTurns: REVIEW_MAX_TURNS })
    log.info(
      'self-review',
      `Review for ${taskName} finished: ${response.content.slice(0, 160).replace(/\n/g, ' ')}`,
    )
    return true
  } finally {
    inFlight.delete(taskId)
  }
}
