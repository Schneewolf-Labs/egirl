import type { ToolDefinition } from './types'
import type { ChatMessage, ToolCall } from '../providers/types'

/**
 * Qwen3 tool calling format utilities.
 *
 * This module handles formatting for the native Qwen3 chat template:
 * - Tool definitions wrapped in <tools></tools> in system prompt
 * - Tool calls wrapped in <tool_call></tool_call>
 * - Tool responses wrapped in <tool_response></tool_response>
 */

const TOOL_CALL_REGEX = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g

const TOOLS_INSTRUCTION = `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{definitions}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>`

/**
 * Convert internal tool definitions to Qwen3 format
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

/**
 * Build the tools section to append to system prompt
 */
export function buildToolsSection(tools: ToolDefinition[] | undefined): string {
  if (!tools || tools.length === 0) return ''

  const definitions = tools
    .map(t => JSON.stringify(formatToolDefinition(t)))
    .join('\n')

  return '\n\n' + TOOLS_INSTRUCTION.replace('{definitions}', definitions)
}

/**
 * Try to parse a JSON string as a tool call, with fallback for Python-style single quotes.
 * Tries the original first; only attempts single-quote fixup if the original fails.
 * The fixup only replaces quotes used as JSON structural delimiters, not those inside strings.
 */
function tryParseToolCallJson(jsonStr: string): { name: string; arguments?: Record<string, unknown> } | undefined {
  // Try original JSON first
  try {
    const parsed = JSON.parse(jsonStr)
    if (parsed && typeof parsed.name === 'string') return parsed
  } catch {
    // Fall through to fixup
  }

  // Fixup: replace single quotes used as JSON delimiters (keys/string values),
  // but not apostrophes inside string content.
  // Strategy: replace 'key': patterns and ': 'value' patterns
  try {
    const fixed = jsonStr
      // Property names: 'name': → "name":
      .replace(/(\{|,)\s*'(\w+)'\s*:/g, '$1 "$2":')
      // String values after colon: : 'value' → : "value"
      // Match colon, optional whitespace, single-quoted string (not containing single quotes)
      .replace(/:\s*'([^']*)'/g, ': "$1"')
    const parsed = JSON.parse(fixed)
    if (parsed && typeof parsed.name === 'string') return parsed
  } catch {
    // Fixup also failed
  }

  return undefined
}

/**
 * Parse tool calls from assistant response content
 */
export function parseToolCalls(content: string): { content: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = []
  let cleanContent = content
  let callIndex = 0

  // Reset regex state
  TOOL_CALL_REGEX.lastIndex = 0

  let match
  while ((match = TOOL_CALL_REGEX.exec(content)) !== null) {
    const jsonStr = match[1]
    if (!jsonStr) continue

    const parsed = tryParseToolCallJson(jsonStr)
    if (parsed?.name) {
      toolCalls.push({
        id: `call_${callIndex++}`,
        name: parsed.name,
        arguments: parsed.arguments ?? {},
      })
      cleanContent = cleanContent.replace(match[0], '')
    }
  }

  return {
    content: cleanContent.trim(),
    toolCalls,
  }
}

/**
 * Format a single tool response
 */
export function formatToolResponse(output: string): string {
  return `<tool_response>\n${output}\n</tool_response>`
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
 * Check if content contains tool calls
 */
export function hasToolCalls(content: string): boolean {
  TOOL_CALL_REGEX.lastIndex = 0
  return TOOL_CALL_REGEX.test(content)
}
