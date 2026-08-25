import type { ChatMessage, ToolDefinition } from '../providers/types'
import { log } from '../util/logger'

/**
 * History hygiene: keep the model's own past malformed tool calls out of its context.
 *
 * A long session accumulates failed calls shaped `{"name": "...", "arguments": {}}`. The chat
 * template renders every one of them back into the prompt verbatim, so the context fills with
 * in-context demonstrations of the malformed shape — and the model, faithfully imitating what
 * it sees, emits more of them. Measured on a real session: the empty-args rate stayed at
 * 56-80% for a full day, unmoved by parser repairs and a KV-precision upgrade, because the
 * contamination was in the history itself.
 *
 * The pruning is applied at render time (non-destructive — the store keeps the full record).
 * The most recent malformed pair is KEPT: the model should still see that its last attempt
 * failed and what the corrective error said. Everything older teaches nothing it needs.
 */

/**
 * Tool names whose schema has at least one required parameter. An empty-args call to one of
 * these has always failed; an empty-args call to anything else (peer_list, git_status) is a
 * legitimate call and must never be pruned.
 */
export function toolsWithRequiredParams(tools: ToolDefinition[]): Set<string> {
  const names = new Set<string>()
  for (const t of tools) {
    const required = (t.parameters as { required?: string[] })?.required
    if (Array.isArray(required) && required.length > 0) names.add(t.name)
  }
  return names
}

function isMalformedCallMessage(msg: ChatMessage, requiredTools: Set<string>): boolean {
  if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) return false
  return msg.tool_calls.every(
    (call) =>
      requiredTools.has(call.name) && (!call.arguments || Object.keys(call.arguments).length === 0),
  )
}

/**
 * Drop every empty-args call/response pair except the most recent one.
 *
 * A "pair" is an assistant message whose calls are ALL empty-args against tools that require
 * arguments, plus the tool-result messages immediately following it. Mixed groups (some calls
 * well-formed) are left alone — pruning part of a group would orphan tool responses.
 */
export function pruneMalformedCallPairs(
  messages: ChatMessage[],
  requiredTools: Set<string>,
): ChatMessage[] {
  // Indices of assistant messages that head a malformed group.
  const groupHeads: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg && isMalformedCallMessage(msg, requiredTools)) groupHeads.push(i)
  }
  if (groupHeads.length <= 1) return messages

  const keepHead = groupHeads[groupHeads.length - 1]
  const drop = new Set<number>()
  for (const head of groupHeads) {
    if (head === keepHead) continue
    drop.add(head)
    // The group's tool results follow immediately.
    for (let j = head + 1; j < messages.length && messages[j]?.role === 'tool'; j++) {
      drop.add(j)
    }
  }

  const out = messages.filter((_, i) => !drop.has(i))
  log.info(
    'history-hygiene',
    `Pruned ${groupHeads.length - 1} stale malformed call pair(s) (${drop.size} messages) from rendered context`,
  )
  return out
}
