/**
 * Helpers for reading what the harness sent to the model, as the proxy recorded it.
 *
 * A turn can produce several chat requests (the operator's own, plus any side work), so a
 * check first has to find the operator request for its turn: the one whose last user message
 * is the turn's text.
 */

import type { RecordedRequest } from './proxy'
import type { TurnResult } from './types'

interface WireMessage {
  role: string
  content?: unknown
}

/** Both shapes egirl has injected recall in: the loop's prefix and retrieveForContext's own. */
export const RECALL_MARKERS = ['[Recalled memories', '[Recalled context from memory']

export function messageText(m: WireMessage): string {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : ''))
      .join('\n')
  }
  return ''
}

function messagesOf(r: RecordedRequest): WireMessage[] {
  const body = r.body as { messages?: unknown }
  return Array.isArray(body.messages) ? (body.messages as WireMessage[]) : []
}

/** Index of the last user message in `msgs` that carries `text`, or -1. */
function lastUserIndex(msgs: WireMessage[], text: string): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as WireMessage
    if (m.role === 'user' && messageText(m).includes(text)) return i
  }
  return -1
}

/** The first chat request in this turn's window that ends on the turn's user message. */
export function operatorRequest(turn: TurnResult): RecordedRequest | undefined {
  return turn.requests.find((r) => {
    if (r.kind !== 'chat') return false
    const msgs = messagesOf(r)
    const i = lastUserIndex(msgs, turn.text)
    return i !== -1 && msgs.slice(i + 1).every((m) => m.role !== 'user' && m.role !== 'assistant')
  })
}

/**
 * The messages this turn added on the user side: everything after the previous assistant reply
 * up to and including the turn's own message. Recall injected for an earlier turn stays in the
 * history (egirl keeps it for prefix-cache stability), so a check scoped to the whole request
 * would blame this turn for the last one's recall.
 */
export function turnTail(r: RecordedRequest, text: string): WireMessage[] {
  const msgs = messagesOf(r)
  const end = lastUserIndex(msgs, text)
  if (end === -1) return []
  let start = end
  while (start > 0 && (msgs[start - 1] as WireMessage).role !== 'assistant') start--
  // The first turn's tail would otherwise reach back into the system prompt.
  return msgs.slice(start, end + 1).filter((m) => m.role !== 'system')
}

/** The first recall block among `msgs`, as a one-line excerpt, or undefined. */
export function findRecall(msgs: WireMessage[]): string | undefined {
  for (const m of msgs) {
    const text = messageText(m)
    const at = Math.min(...RECALL_MARKERS.map((k) => text.indexOf(k)).filter((i) => i !== -1))
    if (Number.isFinite(at)) return oneLine(text.slice(at), 240)
  }
  return undefined
}

/** Whether the turn's text was sent to the embedder: the retrieval gate let it through. */
export function wasEmbedded(turn: TurnResult): boolean {
  return turn.requests.some((r) => {
    if (r.kind !== 'embeddings') return false
    const body = r.body as { input?: unknown; content?: unknown }
    return JSON.stringify(body.input ?? body.content ?? '').includes(
      JSON.stringify(turn.text).slice(1, -1),
    )
  })
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
