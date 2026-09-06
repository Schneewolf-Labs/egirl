import type { ChatMessage, ContentPart } from './types'
import { getTextContent } from './types'

/** A tool call in the OpenAI wire shape the chat template consumes. */
export interface ApiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One message as sent to `/v1/chat/completions`. */
export interface ApiMessage {
  role: string
  content: string | ContentPart[]
  tool_calls?: ApiToolCall[]
  tool_call_id?: string
}

/**
 * Turn egirl's message history into the request the server's chat template expects.
 *
 * The template owns the tool-calling syntax. Sent an assistant turn with `tool_calls` and a
 * `tool` turn with the result, it renders each in the dialect the model was trained on --
 * `<tool_call>` JSON for Qwen3, `<function=>` blocks for Qwen3.5, DSML for DeepSeek -- and puts
 * the tool definitions wherever that model expects them. Doing this by hand meant guessing one
 * dialect for every model and pasting it into the system prompt, and a 9B operator scored 1/8
 * on the delegation ladder under that guess against 5/8 when the template rendered the same
 * conversation itself.
 *
 * So this does as little as possible: arguments become the JSON string the wire format wants,
 * and image results are split out, because a `tool` turn cannot carry an image.
 */
export function toApiMessages(messages: ChatMessage[]): ApiMessage[] {
  const out: ApiMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      out.push({
        role: 'assistant',
        content: getTextContent(msg.content),
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      })
      continue
    }
    if (msg.role === 'tool') {
      const text = getTextContent(msg.content)
      if (text.startsWith('data:image/')) {
        // Templates render a tool turn as text; the image goes in a user turn right after it,
        // which is where every multimodal template accepts one.
        out.push({ role: 'tool', tool_call_id: msg.tool_call_id, content: 'Screenshot captured' })
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Screenshot from the tool call above.' },
            { type: 'image_url', image_url: { url: text } },
          ],
        })
        continue
      }
      out.push({ role: 'tool', tool_call_id: msg.tool_call_id, content: text })
      continue
    }
    out.push({ role: msg.role, content: msg.content })
  }
  return ensureUserQuery(out)
}

/**
 * Qwen-family templates walk the user turns and raise `No user query found in messages` unless
 * at least one is a real question -- they refuse to render a conversation whose entire user side
 * is tool output. llama.cpp surfaces that as a 400, which fails the whole request rather than
 * degrading.
 *
 * A long agentic run reaches that shape legitimately: once context trimming drops the original
 * task prompt, what remains can be assistant tool calls and their results with no plain user
 * turn left. Observed in production -- a reverse-engineering task failed this way repeatedly and
 * auto-paused. Rather than trust every caller to preserve a query, the formatter guarantees one:
 * if none survives, append a minimal continuation turn. The model is mid-task and the tool
 * results are right there, so "continue" is exactly the instruction implied.
 */
function ensureUserQuery(formatted: ApiMessage[]): ApiMessage[] {
  const hasQuery = formatted.some((m) => m.role === 'user' && !isEmpty(m.content))
  if (hasQuery || formatted.length === 0) return formatted
  return [...formatted, { role: 'user', content: 'Continue based on the tool results above.' }]
}

function isEmpty(content: string | ContentPart[]): boolean {
  if (typeof content === 'string') return content.trim() === ''
  return content.length === 0
}
