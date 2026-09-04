/**
 * The durable journal: the trace store as a subscriber to the session bus.
 *
 * Every run narrates on the bus whoever started it, so recording from there covers a CLI
 * turn, a Discord reply and a background task with one tap instead of a call at every site
 * that used to write a transcript line. Per-token events are dropped -- the completed turn
 * carries the whole answer and the thinking -- and tool results land with their full payload,
 * which is what a post-mortem actually needs. Aux model work (compaction, extraction) is not
 * a session run and keeps tracing itself directly.
 */

import { type SessionEvent, subscribeAll } from '../agent/session-events'
import { type TraceEvent, trace } from './traces'

function toTrace(event: SessionEvent): Omit<TraceEvent, 'session'> | undefined {
  switch (event.t) {
    case 'run_start':
      return { kind: 'run_start', payload: { message: event.v.message } }
    case 'turn':
      return {
        kind: 'turn',
        name: event.v.model,
        tokensIn: event.v.input_tokens,
        tokensOut: event.v.output_tokens,
        durationMs: event.v.duration_ms,
        payload: {
          content: event.v.content,
          thinking: event.v.thinking,
          tool_calls: event.v.tool_calls,
        },
      }
    case 'tool_done':
      return {
        kind: 'tool',
        name: event.v.name,
        success: event.v.success,
        payload: { args: event.v.args, output: event.v.output },
      }
    case 'run_end':
      return {
        kind: 'run_end',
        success: !event.v.aborted,
        tokensIn: event.v.input_tokens,
        tokensOut: event.v.output_tokens,
        durationMs: event.v.duration_ms,
        payload: {
          content: event.v.content,
          turns: event.v.turns,
          aborted: event.v.aborted,
          awaiting: event.v.awaiting,
        },
      }
    case 'error':
      return { kind: 'run_end', success: false, payload: { error: event.v } }
    default:
      return undefined
  }
}

/** Start recording session runs into the trace store. Returns the unsubscribe. */
export function journalSessionEvents(): () => void {
  return subscribeAll((session, event) => {
    const record = toTrace(event)
    if (record) trace({ session, ...record })
  })
}
