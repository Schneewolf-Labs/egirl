import { formatToolCall, formatToolResponse } from '../tools/format'
import type { ChatMessage, ContentPart } from './types'

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
    const msg = messages[i]
    if (!msg) break

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

      while (i < messages.length && messages[i]?.role === 'tool') {
        const toolMsg = messages[i]
        if (!toolMsg) break
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

  return ensureUserQuery(formatted)
}

/**
 * A tool result becomes a user turn wrapped in `<tool_response>…</tool_response>`. Qwen3's chat
 * template walks the user turns and raises `No user query found in messages` unless at least one
 * of them is NOT such a wrapper — it refuses to render a conversation whose entire user side is
 * tool output with no actual question. llama.cpp surfaces that as a 400, which fails the whole
 * request rather than degrading.
 *
 * A long agentic run reaches that shape legitimately: once context trimming drops the original
 * task prompt, what remains can be assistant tool-calls and their `<tool_response>` results with
 * no plain user turn left. Observed in production — a reverse-engineering task failed this way
 * repeatedly and auto-paused. Rather than trust every caller to preserve a query, the formatter
 * guarantees one: if none survives, append a minimal continuation turn. The model is mid-task
 * and the tool results are right there, so "continue" is exactly the instruction implied.
 */
function ensureUserQuery(formatted: FormattedMessage[]): FormattedMessage[] {
  const hasQuery = formatted.some((m) => m.role === 'user' && !isToolResponseOnly(m.content))
  if (hasQuery || formatted.length === 0) return formatted
  return [...formatted, { role: 'user', content: 'Continue based on the tool results above.' }]
}

/** True when the turn is nothing but a tool_response wrapper — what the template will not count. */
function isToolResponseOnly(content: FormattedContent): boolean {
  if (typeof content !== 'string') return false
  const trimmed = content.trim()
  if (!trimmed) return true // an empty user turn is no query either
  // Wrapper-agnostic on purpose: dialects differ on the exact tag, so key on the shape they
  // share — the whole turn being one response block — not one dialect's literal string.
  return /^<tool_response>[\s\S]*<\/tool_response>$/.test(trimmed)
}
