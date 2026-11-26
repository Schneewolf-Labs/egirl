/**
 * Every prompt the loop injects into a run to steer the model — checkpoint breaks, wrap-up
 * warnings, recovery nudges, loop warnings. Centralized so the loop bodies stay control flow
 * and the prompts are data: greppable in one place, and shareable by any future port of the
 * core loop. Final-content markers (the "[Run aborted: ...]" strings surfaced to the user)
 * are not nudges and live with the code that ends the run.
 */

/** Planning mode: the first response must be a plan, not actions. */
export function planningModePrompt(request: string): string {
  return `[PLANNING MODE] Create a detailed step-by-step plan for the following request. Do NOT execute any tools yet — only output a numbered plan with clear steps. After the plan is approved, you will execute it.\n\n${request}`
}

/** Operator message queued by inject(), delivered at a turn boundary. */
export function interjectionNudge(message: string): string {
  return `[System: The operator interjected mid-run with the following message. Address it before continuing — it may redirect or end the current work.]\n\n${message}`
}

/** Consolidation break: externalize everything durable before continuing (or before compaction). */
export function checkpointNudge(contextPressed: boolean, rollover = false): string {
  const pressed = rollover
    ? 'Context is nearly full and the window is about to roll over to a fresh one that keeps only your direct inputs and pending tool results — not your reasoning. Write everything durable NOW'
    : 'Context is nearly full and the conversation is about to be compacted. Write everything durable NOW'
  const urgency = contextPressed
    ? pressed
    : 'Pause new work and consolidate — write everything you have learned since your last checkpoint'
  return `[System: Checkpoint. ${urgency} to your durable notes, and save any artifacts to files. Also store anything worth remembering across sessions — a proven fact, a decision and its why, a lesson — with memory_set now, while the context is still in front of you. Assume this run could end at any moment: nothing important should live only in this conversation. Then continue where you left off.]`
}

/**
 * How to report, shared by every wrap-up (the turn cap, its warning, the deadline). Three
 * buckets, so "done" and "done and checked" cannot be blurred into one.
 */
export const HONEST_REPORT =
  'Report in three parts. Checked: what this run confirmed, and how (the command and its result, the file read back). Not checked: done but unconfirmed, including anything only a tool or another agent reported as working. Not done: what remains. Put a claim under Checked only if the tool results of this run back it; when unsure, it goes under Not checked.'

/** Fewest steps of notice before the turn cap, and the smallest cap that gets any (a 1–5 step
 * run is a quick exchange where a warning would eat a real share of it). */
export const TURN_CAP_WARNING_STEPS = 3
export const TURN_CAP_WARNING_MIN_CAP = 6

/**
 * Steps of notice for a cap: a tenth of it, at least three. Landing work -- finishing a file,
 * a commit, the notes -- is a few steps whatever the cap, but a run at a 40-step cap is a big
 * piece of work, and three steps was not enough to put it down cleanly.
 */
export function turnCapWarningSteps(maxTurns: number): number {
  return Math.max(TURN_CAP_WARNING_STEPS, Math.ceil(maxTurns / 10))
}

/**
 * The checklist for the last steps before the cap. Jaeger's capped runs ended with work
 * uncommitted and notes stale, so a continued run started by rediscovering where it was.
 */
export function turnCapChecklist(left: number, maxTurns: number): string {
  return [
    `[System: ${left} steps left in this run — it stops after step ${maxTurns}. Use them to land what you have; do not start anything new:`,
    '1. Finish or save what is in progress. Write files out completely; never leave one half-written.',
    '2. If you changed a git repository, commit the finished work, or say in your reply why it is not committed.',
    '3. Record where you are and the next steps in your notes, so a continued run starts from there.',
    `4. In your reply, say that the run can be continued. ${HONEST_REPORT}]`,
  ].join('\n')
}

/**
 * The turn-cap sibling of the wall-clock wrap-up, fired once, `turnCapWarningSteps` before
 * the cap. Without it the first a run heard of the cap was the forced summary at the end, so
 * work in flight -- a file half-written across steps -- was left as a placeholder.
 *
 * `turn` is the step about to run (1-based). Returns undefined on every other step.
 */
export function turnCapNudge(turn: number, maxTurns: number): string | undefined {
  if (maxTurns < TURN_CAP_WARNING_MIN_CAP) return undefined
  const left = maxTurns - turn + 1
  if (left !== turnCapWarningSteps(maxTurns)) return undefined
  return turnCapChecklist(left, maxTurns)
}

/** One-time wall-clock warning as the run's hard deadline nears: wind down, don't get killed. */
export function wrapupNudge(
  minutesLeft: number,
  tools: { extension?: boolean; endTask?: boolean } = {},
): string {
  const options: string[] = []
  if (tools.extension) {
    options.push(
      'If you are close to finishing and have been making real progress, call request_extension with the minutes you need and what remains — the runner grants it only on evidence of progress in this run, not on your estimate.',
    )
  }
  if (tools.endTask) {
    options.push(
      'If the work is already finished, or you are blocked, call end_task (status done, blocked or abandoned) with a summary to stop cleanly now.',
    )
  }
  const extra = options.length > 0 ? ` ${options.join(' ')}` : ''
  return `[System: You have been working for nearly this round's full time budget — about ${minutesLeft} minute(s) remain before the run ends automatically. Stop starting new work now. Write everything you have learned to your durable notes, save any in-progress artifacts to files, and update your Status/NEXT so the next run resumes cleanly, then give a brief wrap-up. ${HONEST_REPORT} If this run developed a reusable procedure worth keeping — a setup ritual, a debugging recipe, a verified command sequence — and it is not yet a skill, spend one minute writing it as a SKILL.md in your skills directory so future runs start with it. This is a scheduled break, not a failure — you will pick up where you left off in the next run.${extra}]`
}

/** Truncated (finish_reason: length) response: ask for the rest. */
export const CONTINUATION_NUDGE =
  '[System: Your previous response was cut off. Continue exactly where you left off.]'

/** A tool call that failed to parse: ask for a clean reissue. */
export const REISSUE_TOOL_CALL_NUDGE =
  '[System: Your last tool call could not be parsed and was not executed. Reissue it as a single <tool_call> block containing valid JSON: {"name": "<tool>", "arguments": {...}}. Do not repeat this notice.]'

/** Empty response right after tool execution: point the model back at the results. */
export const PROCESS_TOOL_RESULTS_NUDGE =
  '[System: You executed tool calls but returned an empty response. Process the tool results above and continue with the task.]'

/** Turn budget exhausted mid-flow: force a no-tools summary of where the run got to. */
/** It opens by saying it ran out, so the reader doesn't mistake the cap for a choice to stop. */
export const MAX_TURNS_SUMMARY_NUDGE = `[System: You have used all the steps allowed for this run and are being stopped before finishing. Do not call any tools. Begin your reply by saying plainly that you ran out of steps before finishing. ${HONEST_REPORT} End with your best answer so far.]`

/** Fallback feedback when a post-response validator rejects without saying why. */
export const DEFAULT_VALIDATION_FEEDBACK =
  'Your previous response did not pass validation. Please try again.'

/** Post-response validation failed: hand the feedback back for one retry. */
export function validationFailedNudge(feedback: string): string {
  return `[Validation failed]: ${feedback}`
}

/** The model repeated a tool call with identical arguments: warn it off the loop. */
export function duplicateToolWarning(names: string): string {
  return `[Warning: You called ${names} with the same arguments as a previous turn. This may indicate a loop. Try a different approach or respond with your current findings.]`
}
