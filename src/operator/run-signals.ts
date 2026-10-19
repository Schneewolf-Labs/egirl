import { wrapupNudge } from '../agent/nudges'
import type { AgentLoopOptions } from '../agent/types'
import type { ToolResult } from '../tools/types'

/**
 * What a hosted operator's tool results say about the run they belong to.
 *
 * The local loop sees every tool result between model turns and acts on it there: a report ask
 * that timed out parks the run, end_task stops it, the deadline warning goes in before the next
 * inference. A hosted harness runs its own loop, so the only place egirl sees a run in flight is
 * the tool call it serves. These are the same three signals, read from that one place.
 */
export interface RunSignals {
  /** A tool asked for input that never came (report mode=ask timed out). */
  awaitingInput: boolean
  /** A tool ended the run (end_task); its content is the run's reply. */
  ended?: string
  /** The deadline warning has gone out and the deadline has not moved since. */
  wrapupWarned: boolean
}

export function createRunSignals(): RunSignals {
  return { awaitingInput: false, wrapupWarned: false }
}

/** Fold one tool result into the run's signals. True when this result ended the run. */
export function noteResult(signals: RunSignals, result: ToolResult): boolean {
  if (result.awaitingInput) signals.awaitingInput = true
  if (!result.endRun || signals.ended !== undefined) return false
  signals.ended = result.endRun.content
  return true
}

/**
 * The deadline warning, once, on the first tool result inside the wrap-up margin; an
 * extension that moves the deadline back out re-arms it. The local loop's warning is a user
 * turn before the next inference; here it rides on a tool result, which is the only way into a
 * turn the harness is running. A run that calls no tool inside the margin gets no warning and
 * meets the hard timeout as it would anyway.
 */
export function wrapupNote(
  signals: RunSignals,
  options: Pick<AgentLoopOptions, 'deadline' | 'wrapupMarginMs' | 'extraTools'>,
  now = Date.now(),
): string | undefined {
  const deadline = typeof options.deadline === 'function' ? options.deadline() : options.deadline
  if (!deadline) return undefined
  const margin = options.wrapupMarginMs ?? 7 * 60_000
  if (signals.wrapupWarned && now < deadline - margin) signals.wrapupWarned = false
  if (signals.wrapupWarned || now < deadline - margin) return undefined
  signals.wrapupWarned = true
  const minutesLeft = Math.max(1, Math.round((deadline - now) / 60_000))
  return wrapupNudge(minutesLeft, {
    extension: options.extraTools?.has('request_extension') ?? false,
    endTask: options.extraTools?.has('end_task') ?? false,
  })
}
