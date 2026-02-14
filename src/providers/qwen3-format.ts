import type { ChatMessage, ContentPart } from './types'
import { formatToolCall, formatToolResponse } from '../tools/format'

type FormattedContent = string | ContentPart[]
type FormattedMessage = { role: string; content: FormattedContent }

/**
 * Extract text content from string or ContentPart array.
 */
function getTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') {
    return content
  }

  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

/**
 * Format messages for Qwen3 chat template.
 *
 * Key transformations:
 * - Assistant messages with tool_calls: reconstruct <tool_call> XML in content
 *   so the model sees its own tool calls in conversation history
 * - Consecutive tool result messages: group into a single user message with
 *   <tool_response> tags (matches Qwen3 training format)
 * - Image tool results: pass as multimodal content
 */
export function formatMessagesForQwen3(messages: ChatMessage[]): FormattedMessage[] {
  const formatted: FormattedMessage[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // Reconstruct <tool_call> XML so the model sees what it called
      let content = getTextContent(msg.content)
      for (const tc of msg.tool_calls) {
        content += (content ? '\n' : '') + formatToolCall(tc.name, tc.arguments)
      }
      formatted.push({ role: 'assistant', content })
      i++
    } else if (msg.role === 'tool') {
      // Group consecutive tool results into a single user message
      const responseParts: string[] = []

      while (i < messages.length && messages[i]!.role === 'tool') {
        const toolMsg = messages[i]!
        const textContent = getTextContent(toolMsg.content)

        if (textContent.startsWith('data:image/')) {
          // Flush text responses first, then handle image separately
          if (responseParts.length > 0) {
            formatted.push({ role: 'user', content: responseParts.join('\n') })
            responseParts.length = 0
          }
          formatted.push({
            role: 'user',
            content: [
              { type: 'text', text: formatToolResponse('Screenshot captured') },
              { type: 'image_url', image_url: { url: textContent } },
            ],
          })
        } else {
          responseParts.push(formatToolResponse(textContent))
        }
        i++
      }

      if (responseParts.length > 0) {
        formatted.push({ role: 'user', content: responseParts.join('\n') })
      }
    } else if (Array.isArray(msg.content)) {
      formatted.push({ role: msg.role, content: msg.content })
      i++
    } else {
      formatted.push({ role: msg.role, content: msg.content })
      i++
    }
  }

  return formatted
}
