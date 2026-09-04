import type { ToolCall } from '../providers/types'
import { toolDialect } from './dialects'
import type { ToolDefinition } from './types'

/**
 * Qwen3 tool calling format utilities.
 *
 * This module handles formatting for the native Qwen3 chat template:
 * - Tool definitions wrapped in <tools></tools> in system prompt
 * - Tool calls wrapped in <tool_call></tool_call>
 * - Tool responses wrapped in <tool_response></tool_response>
 */

/**
 * Tool-call formatting, delegated to the configured dialect (see ./dialects.ts).
 * Rendering and parsing must agree, so both come from the same dialect object rather
 * than being hardcoded to one model family.
 */
export function buildToolsSection(tools: ToolDefinition[] | undefined): string {
  return toolDialect().buildToolsSection(tools)
}

/** Parse tool calls from assistant response content. */
export function parseToolCalls(content: string): { content: string; toolCalls: ToolCall[] } {
  return toolDialect().parseToolCalls(content)
}

/**
 * Format a single tool response
 */
export function formatToolResponse(output: string): string {
  return toolDialect().formatToolResponse(output)
}

/**
 * Format a tool call for the assistant message
 */
export function formatToolCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`
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
