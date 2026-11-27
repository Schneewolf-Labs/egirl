import type { AgentEventHandler } from '../agent/events'
import type { AgentResponse } from '../agent/types'
import { READ_ONLY_TOOLS } from './discovery'

/**
 * What a task run's tools did, for deciding whether the run is worth mining for memories.
 *
 * A heartbeat that finds HEAD unchanged and nothing to do still went through memory and lesson
 * extraction, and a talkative extractor turned "the item stays unchecked because it recurs"
 * into a fresh near-duplicate memory every half hour, which recall then pushed under unrelated
 * messages. Whether it does that depends on the extractor model, so a prompt tweak only moves
 * the odds. The gate is mechanical instead: a run that only looked, and hit no errors, has
 * nothing to extract.
 */
export interface RunToolTally {
  /** Calls to tools outside READ_ONLY_TOOLS, by name. */
  mutating: string[]
  /** Calls that returned success: false, by name. */
  failed: string[]
}

const READ_ONLY = new Set(READ_ONLY_TOOLS)

/** A tally and the event handler that fills it; pass the handler to the run. */
export function createRunToolTally(): { tally: RunToolTally; events: AgentEventHandler } {
  const tally: RunToolTally = { mutating: [], failed: [] }
  return {
    tally,
    events: {
      onToolCallComplete(_callId, name, result) {
        if (!READ_ONLY.has(name)) tally.mutating.push(name)
        if (!result.success) tally.failed.push(name)
      },
    },
  }
}

/**
 * Why extraction can be skipped for this run, or undefined when it should run. Skipped only
 * when the run ended cleanly (not aborted, not waiting, not cut off, no retries), called no
 * tool outside the read-only set, and no tool failed.
 */
export function noopRunReason(response: AgentResponse, tally: RunToolTally): string | undefined {
  if (response.aborted || response.awaitingInput || response.turnLimitReached) return undefined
  if (response.truncated || (response.continuationRetries ?? 0) > 0) return undefined
  if (tally.mutating.length > 0 || tally.failed.length > 0) return undefined
  return 'run succeeded with only read-only tool calls and no tool errors'
}
