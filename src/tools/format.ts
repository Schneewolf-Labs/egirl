import type { ChatMessage, ToolCall } from '../providers/types'
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
export function formatToolDefinition(tool: ToolDefinition): object {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

/** Build the tools section to append to the system prompt. */
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
 * Format multiple tool responses into a single user message
 */
export function formatToolResponses(results: Map<string, { output: string }>): string {
  const responses: string[] = []

  for (const [_id, result] of results) {
    responses.push(formatToolResponse(result.output))
  }

  return responses.join('\n')
}

/**
 * Create a tool response message (Qwen3 uses user role)
 */
export function createToolResponseMessage(results: Map<string, { output: string }>): ChatMessage {
  return {
    role: 'user',
    content: formatToolResponses(results),
  }
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
