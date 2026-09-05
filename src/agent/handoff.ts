import type { ChatMessage, ToolCall } from '../providers/types'
import { getTextContent } from '../providers/types'
import { isRecallMessage } from './recall'

/**
 * Context rollover: the handoff record that seeds a fresh window.
 *
 * The alternative to summarizing. When the conversation no longer fits, nothing is condensed:
 * the window is replaced by ONE user message built mechanically from the transcript — the
 * operator's direct inputs verbatim, the supervisor's replies to asks, the tool batch the model
 * has not yet responded to, and whatever the model itself handed over via new_context. Older
 * assistant prose and consumed tool results are deliberately not treated as state: the durable
 * record lives in the agent's notes and memory, and the full transcript stays in the
 * conversation store where session_search can find it.
 *
 * No LLM call, so no "empty summary" failure and no aux-model slot spent. The idea is
 * fitchmultz/pi-posthorse; see docs/autonomy-loop.md ("recycle from NOTES").
 */

export const ROLLOVER_PREFIX = '[System: Context rollover.'

/** Upper bound on the record — it exists to SHRINK the window, so it stays small. */
export const DEFAULT_HANDOFF_CHARS = 8_000

const MAX_INPUT_CHARS = 1_200
const MAX_REPLIES = 3
const INTERJECTION_PREFIX = '[System: The operator interjected'

export interface HandoffOptions {
  /** 'auto' — the window filled up; 'requested' — the model called new_context. */
  reason: 'auto' | 'requested'
  /** Text the model supplied via new_context, carried verbatim (bounded). */
  handoff?: string
  maxChars?: number
}

export function isRolloverRecord(message: ChatMessage): boolean {
  return (
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(ROLLOVER_PREFIX)
  )
}

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, Math.max(0, max - 3))}...` : t
}

/**
 * A user message that is the operator's own words. Loop nudges (`[System: ...]`), recall
 * injections, recovery scaffolding and earlier rollover records are the loop talking to the
 * model, not state. An interjection carries operator text inside a nudge wrapper — unwrap it.
 */
function operatorInput(message: ChatMessage): string | undefined {
  if (message.role !== 'user' || message.ephemeral || isRecallMessage(message)) return undefined
  const text = getTextContent(message.content)?.trim()
  if (!text) return undefined
  if (text.startsWith(INTERJECTION_PREFIX)) {
    const body = text.slice(text.indexOf(']') + 1).trim()
    return body || undefined
  }
  if (text.startsWith('[System:') || text.startsWith('[Warning:')) return undefined
  if (text.startsWith('[Validation failed]')) return undefined
  return text
}

/** Operator inputs, newest first until the budget is spent, then back in order. */
function renderOperatorInputs(messages: ChatMessage[], budget: number): string {
  const inputs = messages.map(operatorInput).filter((t): t is string => t !== undefined)
  if (inputs.length === 0) return ''
  const kept: string[] = []
  let used = 0
  for (let i = inputs.length - 1; i >= 0; i--) {
    const line = `- ${clip(inputs[i] as string, MAX_INPUT_CHARS)}`
    if (used + line.length > budget && kept.length > 0) break
    kept.unshift(line)
    used += line.length + 1
  }
  const omitted = inputs.length - kept.length
  const note =
    omitted > 0 ? `\n(${omitted} earlier input(s) omitted — session_search finds them.)` : ''
  return `## Operator inputs (verbatim, oldest first)\n${kept.join('\n')}${note}`
}

/** Replies the supervisor gave to `report` asks — decisions the model must not re-ask. */
function renderSupervisorReplies(messages: ChatMessage[], budget: number): string {
  const pairs: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg?.role !== 'assistant' || !msg.tool_calls) continue
    for (const call of msg.tool_calls) {
      if (call.name !== 'report' || call.arguments?.mode !== 'ask') continue
      const reply = messages
        .slice(i + 1)
        .find((m) => m.role === 'tool' && m.tool_call_id === call.id)
      const replyText = reply ? getTextContent(reply.content) : undefined
      if (!replyText) continue
      const asked = clip(String(call.arguments?.message ?? ''), 200)
      pairs.push(`- asked: ${asked}\n  reply: ${clip(replyText, 400)}`)
    }
  }
  if (pairs.length === 0) return ''
  const recent = pairs.slice(-MAX_REPLIES)
  return clip(`## Supervisor replies to your asks\n${recent.join('\n')}`, budget)
}

function renderCall(call: ToolCall, result: ChatMessage | undefined, perResult: number): string {
  const args = clip(JSON.stringify(call.arguments ?? {}), 200)
  const out = result ? getTextContent(result.content) : undefined
  const outcome = out ? clip(out, perResult) : '(no result)'
  return `- ${call.name}(${args})\n  → ${outcome}`
}

/**
 * The trailing tool batch the model has not responded to yet — the one observation it must
 * act on next, so it survives rollover in full (bounded per result).
 */
function renderPendingBatch(messages: ChatMessage[], budget: number): string {
  let i = messages.length - 1
  while (i >= 0 && messages[i]?.role === 'tool') i--
  const head = messages[i]
  if (i === messages.length - 1 || head?.role !== 'assistant' || !head.tool_calls?.length) {
    return ''
  }
  const results = messages.slice(i + 1)
  const perResult = Math.max(120, Math.floor(budget / head.tool_calls.length) - 260)
  const lines = head.tool_calls.map((call) =>
    renderCall(
      call,
      results.find((r) => r.tool_call_id === call.id),
      perResult,
    ),
  )
  const said = getTextContent(head.content)?.trim()
  const intro = said ? `You said: ${clip(said, 300)}\n` : ''
  return `## Pending tool results (your last action before rollover)\n${intro}${lines.join('\n')}`
}

function header(messages: ChatMessage[], reason: HandoffOptions['reason']): string {
  const toolCalls = messages.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0)
  const why =
    reason === 'requested'
      ? 'You requested a fresh context window with new_context.'
      : 'The previous context window filled up and was rolled over to this fresh one.'
  return (
    `${ROLLOVER_PREFIX} ${why} ${messages.length} messages (${toolCalls} tool calls) were ` +
    'retired from the window. Nothing was summarized: older assistant prose and consumed tool ' +
    'results are not carried over, but the full transcript is preserved and searchable with ' +
    "session_search. Below is a mechanical record of the operator's direct inputs and the " +
    'pending tool results — NOT a summary of your progress and NOT proof that anything was ' +
    'done. Re-orient from your durable notes and pinned state first, use session_search for ' +
    'anything specific, and verify live state (files, git, running processes) before any ' +
    'stateful or external action. Then continue the work.]'
  )
}

/** Build the single user message that replaces the retired window. Pure. */
export function buildHandoffRecord(messages: ChatMessage[], opts: HandoffOptions): ChatMessage {
  const maxChars = opts.maxChars ?? DEFAULT_HANDOFF_CHARS
  const parts = [header(messages, opts.reason)]
  let remaining = maxChars - (parts[0] as string).length

  const handoff = opts.handoff?.trim()
  if (handoff) {
    const section = `## Handoff from your previous window\n${clip(handoff, Math.min(3_000, remaining * 0.4))}`
    parts.push(section)
    remaining -= section.length
  }

  const pending = renderPendingBatch(messages, Math.floor(remaining * 0.4))
  const replies = renderSupervisorReplies(messages, Math.floor(remaining * 0.15))
  remaining -= pending.length + replies.length

  const inputs = renderOperatorInputs(messages, Math.max(400, remaining))
  for (const section of [inputs, replies, pending]) if (section) parts.push(section)

  return { role: 'user', content: parts.join('\n\n') }
}
