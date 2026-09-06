import type { ToolCall } from '../providers/types'
import { toolDialect } from './dialects'

/**
 * Tool calls that come back as text.
 *
 * Tools are sent to the server as `tools` and rendered by the model's chat template, and a
 * llama.cpp server running with --jinja parses the calls out of the generation itself. What
 * remains here is the fallback for a server that renders but does not parse, and for the
 * odd call a model writes free-hand outside the grammar: find the markup in the assistant's
 * text, in whichever dialect it used, and turn it into calls.
 */

/** Parse tool calls from assistant response content. */
export function parseToolCalls(content: string): { content: string; toolCalls: ToolCall[] } {
  return toolDialect().parseToolCalls(content)
}

/**
 * Check if content contains tool calls (in whichever dialect is active).
 */
export function hasToolCalls(content: string): boolean {
  return toolDialect().parseToolCalls(content).toolCalls.length > 0
}

/**
 * Tool-call markup that the parser could not turn into a call.
 *
 * Worth telling apart from ordinary prose, because the two want opposite handling: prose is
 * the model's answer, while a stranded call is an action that was attempted and lost. Treated
 * as an answer it ends the turn and prints raw markup at the user -- which reads, from the
 * outside, as the model thinking, calling a tool, and then simply stopping.
 */
export function hasStrandedToolCall(content: string): boolean {
  return content.includes('<tool_call>') && !hasToolCalls(content)
}

/**
 * Remove tool-call markup that survived every repair and reissue attempt.
 *
 * Called when recovery gives up: the alternative is printing raw XML as the agent's reply.
 * The replacement note is honest about what happened without dumping the broken call.
 */
export function stripStrandedToolCalls(content: string): string {
  return content
    .replace(
      /<tool_call>[\s\S]*?(<\/tool_call>|$)/g,
      '[a tool call failed to parse and was dropped]',
    )
    .trim()
}
