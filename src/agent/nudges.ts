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
export function checkpointNudge(contextPressed: boolean): string {
  const urgency = contextPressed
    ? 'Context is nearly full and the conversation is about to be compacted. Write everything durable NOW'
    : 'Pause new work and consolidate — write everything you have learned since your last checkpoint'
  return `[System: Checkpoint. ${urgency} to your durable notes, and save any artifacts to files. Also store anything worth remembering across sessions — a proven fact, a decision and its why, a lesson — with memory_set now, while the context is still in front of you. Assume this run could end at any moment: nothing important should live only in this conversation. Then continue where you left off.]`
}

/** One-time wall-clock warning as the run's hard deadline nears: wind down, don't get killed. */
export function wrapupNudge(minutesLeft: number): string {
  return `[System: You have been working for nearly this round's full time budget — about ${minutesLeft} minute(s) remain before the run ends automatically. Stop starting new work now. Write everything you have learned to your durable notes, save any in-progress artifacts to files, and update your Status/NEXT so the next run resumes cleanly, then give a brief wrap-up. If this run developed a reusable procedure worth keeping — a setup ritual, a debugging recipe, a verified command sequence — and it is not yet a skill, spend one minute writing it as a SKILL.md in your skills directory so future runs start with it. This is a scheduled break, not a failure — you will pick up where you left off in the next run.]`
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
export const MAX_TURNS_SUMMARY_NUDGE =
  '[System: Maximum turns reached. Do not call any tools. Summarize what you accomplished, what remains unfinished, and your best answer so far.]'

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
