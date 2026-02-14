import type { ChatMessage, LLMProvider } from '../providers/types'
import { getTextContent } from '../providers/types'
import { log } from '../util/logger'

const SUMMARIZE_SYSTEM_PROMPT = `You are a context compaction assistant. Your job is to read a conversation segment and produce a concise summary that preserves all information needed to continue the conversation.

Focus on:
- Key facts, decisions, and conclusions reached
- What the user asked for and what was accomplished
- Tool calls made and their important results (file paths, values found, errors hit)
- Current task state — what's done, what's in progress, what's next
- User preferences or constraints mentioned

Rules:
- Be concise — aim for roughly 1/5 the length of the input
- Use bullet points
- Preserve specific values: file paths, variable names, error messages, numbers
- Do NOT include pleasantries, greetings, or filler
- Do NOT add analysis or suggestions — just summarize what happened
- Write in past tense for completed actions, present tense for ongoing state`

const MAX_SUMMARY_TOKENS = 500
const MAX_INPUT_CHARS = 50_000

/**
 * Format a batch of messages into a readable conversation transcript
 * for the summarizer to process.
 */
function formatMessagesForSummary(messages: ChatMessage[]): string {
  const lines: string[] = []

  for (const msg of messages) {
    const text = getTextContent(msg.content)
    if (!text && !msg.tool_calls) continue

    switch (msg.role) {
      case 'user':
        lines.push(`User: ${text}`)
        break
      case 'assistant':
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const toolNames = msg.tool_calls
            .map((c) => `${c.name}(${JSON.stringify(c.arguments)})`)
            .join(', ')
          lines.push(`Assistant: ${text ? `${text} ` : ''}[Called: ${toolNames}]`)
        } else {
          lines.push(`Assistant: ${text}`)
        }
        break
      case 'tool': {
        const truncated = text.length > 500 ? `${text.slice(0, 500)}...` : text
        lines.push(`Tool result (${msg.tool_call_id ?? 'unknown'}): ${truncated}`)
        break
      }
      case 'system':
        if (text.startsWith('[Recalled memories')) {
          lines.push(`[Memory recall]: ${text.slice(0, 300)}`)
        }
        // Skip other system messages (they're injected context, not conversation)
        break
    }
  }

  return lines.join('\n')
}

/**
 * Summarize a batch of dropped messages into a compact context block.
 *
 * Uses the provided LLM provider (typically local) to generate a summary.
 * Falls back to a simple extraction if the LLM call fails.
 */
export async function summarizeMessages(
  messages: ChatMessage[],
  provider: LLMProvider,
  existingSummary?: string,
): Promise<string> {
  if (messages.length === 0) return existingSummary ?? ''

  const transcript = formatMessagesForSummary(messages)
  if (!transcript.trim()) return existingSummary ?? ''

  // Truncate if the transcript is too long — we need it to fit in context
  const truncatedTranscript =
    transcript.length > MAX_INPUT_CHARS
      ? `${transcript.slice(0, MAX_INPUT_CHARS)}\n\n[...transcript truncated for summarization]`
      : transcript

  const userPrompt = existingSummary
    ? `Here is the existing conversation summary:\n\n${existingSummary}\n\n---\n\nHere are new messages being compacted:\n\n${truncatedTranscript}\n\n---\n\nProduce an updated summary that merges the existing summary with the new information. Keep it concise.`
    : `Summarize the following conversation segment:\n\n${truncatedTranscript}`

  try {
    const response = await provider.chat({
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: MAX_SUMMARY_TOKENS,
      temperature: 0.1,
    })

    const summary = response.content.trim()
    if (!summary) {
      log.warn('context-summarizer', 'LLM returned empty summary, falling back to extraction')
      return fallbackSummary(messages, existingSummary)
    }

    log.info(
      'context-summarizer',
      `Generated summary (${summary.length} chars) from ${messages.length} messages`,
    )
    return summary
  } catch (error) {
    log.warn('context-summarizer', 'Summary generation failed, using fallback:', error)
    return fallbackSummary(messages, existingSummary)
  }
}

/**
 * Simple fallback summary when the LLM is unavailable.
 * Extracts user messages and tool call names to preserve basic context.
 */
function fallbackSummary(messages: ChatMessage[], existingSummary?: string): string {
  const parts: string[] = []

  if (existingSummary) {
    parts.push(existingSummary)
    parts.push('')
  }

  const userMessages = messages
    .filter((m) => m.role === 'user')
    .map((m) => {
      const text = getTextContent(m.content)
      return text.length > 200 ? `${text.slice(0, 200)}...` : text
    })
    .filter(Boolean)

  const toolCalls = messages
    .filter((m) => m.role === 'assistant' && m.tool_calls)
    .flatMap((m) => m.tool_calls?.map((c) => c.name))

  if (userMessages.length > 0) {
    parts.push('User messages:')
    for (const msg of userMessages) {
      parts.push(`- ${msg}`)
    }
  }

  if (toolCalls.length > 0) {
    const unique = [...new Set(toolCalls)]
    parts.push(`Tools used: ${unique.join(', ')}`)
  }

  return parts.join('\n')
}

/**
 * Format a summary for injection into the conversation context.
 */
export function formatSummaryMessage(summary: string): ChatMessage {
  return {
    role: 'system',
    content: `[Conversation summary — earlier messages were compacted to fit context window]\n\n${summary}`,
  }
}
