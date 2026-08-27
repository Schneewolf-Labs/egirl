/**
 * Mutable state of a single agent run: every counter and flag the turn loop and the recovery
 * rules read or write, in one struct instead of scattered locals. The fields document the
 * loop's implicit state machine; anything that resets between runs belongs here, anything
 * that survives a run (history, context, compaction) does not.
 */
export interface RunState {
  /** Turns started so far this run (incremented at the top of each loop iteration). */
  turns: number
  /** Whether any tool has executed this run — separates the two empty-response rules. */
  toolsRan: boolean
  /** A tool reported it is waiting on supervisor input that never came. */
  awaitingInput: boolean
  /** Content carried across truncation continuations, prepended to the final reply. */
  accumulatedContent: string
  /** Continuations issued for truncated (finish_reason: length) responses. */
  continuationRetries: number
  /** Reissue nudges sent for tool calls that failed to parse. */
  strandedToolRetries: number
  /** Re-prompts sent after an empty response that followed tool execution. */
  emptyAfterToolsRetries: number
  /** Silent retries of an empty response with no tools in play. */
  emptyRetries: number
  /** Whether the previous empty attempt generated zero output tokens (deterministic-empty rule). */
  prevEmptyWasZeroOutput: boolean
  /** Whether the one-shot post-response validation retry has been spent. */
  validationRetried: boolean
  /** Input tokens of the last inference — the context-pressure consolidation trigger reads this. */
  lastInputTokens: number
  /** Turn at which the last context-pressure checkpoint fired, rate-limiting that trigger. */
  lastContextBreakTurn: number
  /** Whether the one-time wall-clock wrap-up warning has been injected. */
  wrapupWarned: boolean
}

export function createRunState(): RunState {
  return {
    turns: 0,
    toolsRan: false,
    awaitingInput: false,
    accumulatedContent: '',
    continuationRetries: 0,
    strandedToolRetries: 0,
    emptyAfterToolsRetries: 0,
    emptyRetries: 0,
    prevEmptyWasZeroOutput: false,
    validationRetried: false,
    lastInputTokens: 0,
    lastContextBreakTurn: -Infinity,
    wrapupWarned: false,
  }
}
