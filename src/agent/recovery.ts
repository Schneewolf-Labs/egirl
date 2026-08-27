/**
 * Recovery rules for a model response that produced no executable tool calls.
 *
 * Every recovery path shares one skeleton: a predicate on the response, a bounded retry
 * counter, a nudge that hands the problem back to the model. Expressing them as an ordered
 * rule table keeps the loop body to control flow and makes the retry semantics auditable in
 * one place. Rules are walked in order; the first whose predicate matches decides the turn's
 * outcome. A matched rule with retries left fires (queueing a nudge or a silent retry) and the
 * loop runs another turn; an exhausted rule either aborts the run or falls through to the next
 * rule — and past the last rule the response is accepted as the final answer.
 */
import type { ChatResponse } from '../providers/types'
import { hasStrandedToolCall } from '../tools/format'
import { log } from '../util/logger'
import { type AgentContext, addMessage } from './context'
import { CONTINUATION_NUDGE, PROCESS_TOOL_RESULTS_NUDGE, REISSUE_TOOL_CALL_NUDGE } from './nudges'
import { isRepetitionDominated } from './repetition-guard'
import type { RunState } from './run-state'

/** Maximum number of continuation retries when response is truncated (finish_reason: length) */
const MAX_CONTINUATION_RETRIES = 3

/**
 * Cap on each recovery nudge (stranded tool call, empty-after-tools). Hermes uses 3; one was
 * measurably not enough -- a 27B that mangles a call under context pressure often needs a
 * second clean look at the instruction.
 */
const MAX_RECOVERY_NUDGES = 3

/**
 * Retries for a with-no-tools empty response. Distinct from MAX_RECOVERY_NUDGES because these
 * retries add no message -- the request is identical, so the KV-cached prefill makes each one
 * cheap -- and the deterministic-empty rule usually cuts them off before the cap anyway.
 */
const MAX_EMPTY_RETRIES = 2

export type RecoveryOutcome =
  /** A nudge or silent retry was queued — run another turn. */
  | { action: 'retry' }
  /** The response is unusable and retrying can't help — end the run with this content. */
  | { action: 'abort'; finalContent: string }
  /** No rule claimed the response — accept it as the final answer. */
  | { action: 'accept' }

interface RecoveryRule {
  name: string
  /** Retry budget for this rule per run. */
  cap: number
  /** Does this rule apply to the response at all? */
  when(response: ChatResponse, state: RunState): boolean
  /** Retries already spent, read from the run state. */
  spent(state: RunState): number
  /** A retry is available but would make things worse — abort with this final content. */
  abortReason?(response: ChatResponse, state: RunState): string | undefined
  /** Extra retry gate beyond the cap (e.g. the deterministic-empty rule). */
  canRetry?(response: ChatResponse, state: RunState): boolean
  /** Queue one retry: bump the counter and append any nudge messages. */
  fire(response: ChatResponse, state: RunState, context: AgentContext): void
  /** Retries exhausted: return content to abort the run with, or undefined to fall through. */
  onExhausted?(response: ChatResponse, state: RunState): string | undefined
}

const rules: RecoveryRule[] = [
  // The response was cut off mid-thought (finish_reason: length). Echo what arrived, ask for
  // the rest, and stitch the pieces together in accumulatedContent. Both halves persist:
  // unlike the rules below, a truncated response is real work in progress, not a failure.
  {
    name: 'continuation',
    cap: MAX_CONTINUATION_RETRIES,
    when: (response) => response.finish_reason === 'length' && response.content.length > 0,
    spent: (state) => state.continuationRetries,
    // A repetition loop also finishes with finish_reason=length -- the model spent its
    // whole budget echoing one fragment. Continuing would stitch MORE of the echo onto
    // the answer (hermes's incident: one turn, 60k chars, 31 Discord messages). Abort
    // the turn with what we have instead of asking for another round of it.
    abortReason: (response, state) => {
      if (!isRepetitionDominated(response.content)) return undefined
      log.warn(
        'agent',
        `Truncated response is repetition-dominated (${response.content.length} chars) — aborting continuation`,
      )
      return `${state.accumulatedContent + response.content}\n\n[Response aborted: the model entered a repetition loop.]`
    },
    fire: (response, state, context) => {
      state.continuationRetries++
      state.accumulatedContent += response.content
      log.info(
        'agent',
        `Response truncated (finish_reason: length), continuation retry ${state.continuationRetries}/${MAX_CONTINUATION_RETRIES}`,
      )
      addMessage(context, { role: 'assistant', content: response.content })
      addMessage(context, { role: 'user', content: CONTINUATION_NUDGE })
    },
  },

  // The model tried to act, but its call did not parse -- the markup is still sitting
  // in the content. Accepting it as an answer would end the turn and print raw XML at
  // the user, discarding the action silently. Hand it back and let it retry: a model
  // that mangled its JSON usually gets it right on a clean re-issue. Both halves of
  // the pair are ephemeral -- the mangled markup and the nudge exist only to drive
  // this retry, and persisting them would replay the failure into future context.
  // When retries run out, acceptance strips the dead markup rather than printing it.
  {
    name: 'stranded-tool-call',
    cap: MAX_RECOVERY_NUDGES,
    when: (response) => hasStrandedToolCall(response.content),
    spent: (state) => state.strandedToolRetries,
    fire: (response, state, context) => {
      state.strandedToolRetries++
      log.info(
        'agent',
        `Tool call could not be parsed; asking for a reissue (${state.strandedToolRetries}/${MAX_RECOVERY_NUDGES})`,
      )
      addMessage(context, { role: 'assistant', content: response.content, ephemeral: true })
      addMessage(context, { role: 'user', content: REISSUE_TOOL_CALL_NUDGE, ephemeral: true })
      state.accumulatedContent = ''
      state.continuationRetries = 0
    },
  },

  // Tools just ran and the model came back with nothing -- no text, no further calls.
  // Ending the turn here surfaces an empty reply with work visibly half-done. Point it
  // back at the tool results it ignored. Same ephemeral contract as above.
  {
    name: 'empty-after-tools',
    cap: MAX_RECOVERY_NUDGES,
    when: (response, state) => !response.content.trim() && state.toolsRan,
    spent: (state) => state.emptyAfterToolsRetries,
    fire: (_response, state, context) => {
      state.emptyAfterToolsRetries++
      log.info(
        'agent',
        `Empty response after tool execution; re-prompting (${state.emptyAfterToolsRetries}/${MAX_RECOVERY_NUDGES})`,
      )
      addMessage(context, { role: 'user', content: PROCESS_TOOL_RESULTS_NUDGE, ephemeral: true })
    },
  },

  // An empty response with no tools in play at all. Previously this surfaced as a blank
  // reply; now it retries, bounded by hermes's deterministic-empty rule: two consecutive
  // attempts with output_tokens === 0 mean the same prompt will keep producing the same
  // empty, so further retries are burned prefill for nothing. An attempt that generated
  // SOMETHING (output_tokens > 0 with empty content -- reasoning ate the budget, or
  // think-stripping ate the text) is not deterministic and keeps its budget: sampling
  // can land differently next time.
  {
    name: 'empty-response',
    cap: MAX_EMPTY_RETRIES,
    when: (response, state) => !response.content.trim() && !state.toolsRan,
    spent: (state) => state.emptyRetries,
    canRetry: (response, state) =>
      !(response.usage.output_tokens === 0 && state.prevEmptyWasZeroOutput),
    fire: (response, state) => {
      state.emptyRetries++
      state.prevEmptyWasZeroOutput = response.usage.output_tokens === 0
      log.warn(
        'agent',
        `Empty response (output_tokens=${response.usage.output_tokens}), retrying (${state.emptyRetries}/${MAX_EMPTY_RETRIES})`,
      )
    },
    onExhausted: (response, state) => {
      log.warn(
        'agent',
        response.usage.output_tokens === 0 && state.prevEmptyWasZeroOutput
          ? 'Empty response is deterministic (two zero-output attempts) — giving up'
          : `Empty response after ${state.emptyRetries} retries — giving up`,
      )
      return '[The model returned an empty response.]'
    },
  },
]

/**
 * Walk the recovery rules against a no-tool-calls response. Fires at most one rule; the
 * caller acts on the outcome (retry the loop, abort the run, or accept the response).
 */
export function attemptRecovery(
  response: ChatResponse,
  state: RunState,
  context: AgentContext,
): RecoveryOutcome {
  for (const rule of rules) {
    if (!rule.when(response, state)) continue
    if (rule.spent(state) < rule.cap && (rule.canRetry?.(response, state) ?? true)) {
      const abortContent = rule.abortReason?.(response, state)
      if (abortContent !== undefined) return { action: 'abort', finalContent: abortContent }
      rule.fire(response, state, context)
      return { action: 'retry' }
    }
    const exhausted = rule.onExhausted?.(response, state)
    if (exhausted !== undefined) return { action: 'abort', finalContent: exhausted }
  }
  return { action: 'accept' }
}
