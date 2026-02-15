import type { ChatMessage, LLMProvider } from '../providers/types'
import { getTextContent } from '../providers/types'
import { log } from '../util/logger'
import type { MemoryCategory } from './indexer'

export interface CompactionExtraction {
  key: string
  value: string
  category: MemoryCategory
}

const FLUSH_PROMPT = `You are a memory preservation system. Messages from an ongoing conversation are about to be dropped from context to free space. Your job is to extract any important information that should be durably remembered so it is not silently lost.

Focus on:
- Active task state: what is in progress, what is blocked, what is next
- Decisions made and their rationale
- Specific values: file paths, variable names, URLs, error messages, version numbers
- User requests or instructions that haven't been fully addressed yet
- Constraints, requirements, or preferences stated by the user

Rules:
- Only extract information that would be needed to continue the conversation correctly
- Be precise — include exact names, paths, and values rather than vague summaries
- Skip greetings, acknowledgments, and filler
- If a tool was called and returned important data, preserve the key result
- Do NOT re-extract information that was already stored via memory_set tool calls
- Each value should be 1-3 sentences max
- If there is nothing worth preserving, return an empty array: []
- Output ONLY a JSON array, no other text

For each item output:
- "key": short snake_case identifier with topic context (e.g., "task_migrate_auth_status", "error_db_connection_fix")
- "value": concise but complete description
- "category": one of "fact", "preference", "decision", "project", "entity"

Conversation segment being dropped:
`

const MAX_INPUT_CHARS = 40_000
const MAX_FLUSH_EXTRACTIONS = 8

/**
 * Extract durable facts from messages about to be dropped during context compaction.
 *
 * Unlike post-conversation auto-extraction, this targets messages that are being
 * lost from context — the emphasis is on preserving task state and critical details
 * that the summarizer might compress away.
 */
export async function flushBeforeCompaction(
  droppedMessages: ChatMessage[],
  provider: LLMProvider,
  maxExtractions = MAX_FLUSH_EXTRACTIONS,
): Promise<CompactionExtraction[]> {
  if (droppedMessages.length === 0) return []

  const transcript = condenseForFlush(droppedMessages)
  if (transcript.length < 30) return []

  const truncated =
    transcript.length > MAX_INPUT_CHARS
      ? `${transcript.slice(0, MAX_INPUT_CHARS)}\n\n[...truncated]`
      : transcript

  try {
    const response = await provider.chat({
      messages: [{ role: 'user', content: FLUSH_PROMPT + truncated }],
      temperature: 0.1,
      max_tokens: 1024,
    })

    return parseFlushExtractions(response.content, maxExtractions)
  } catch (error) {
    log.warn('compaction-flush', 'Pre-compaction memory flush failed:', error)
    return []
  }
}

/**
 * Build a condensed transcript of the dropped messages for extraction.
 * Includes tool results (unlike the post-conversation extractor) because
 * tool outputs often contain the critical data we need to preserve.
 */
function condenseForFlush(messages: ChatMessage[]): string {
  const lines: string[] = []

  for (const msg of messages) {
    const text = getTextContent(msg.content)

    // Skip system messages (memory injections, summary notices)
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      if (!text) continue
      const trimmed = text.length > 500 ? `${text.slice(0, 500)}...` : text
      lines.push(`User: ${trimmed}`)
      continue
    }

    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const toolNames = msg.tool_calls.map((tc) => tc.name).join(', ')
        if (text?.trim()) {
          lines.push(`Assistant: ${text.slice(0, 300)}`)
        }
        lines.push(`[Called tools: ${toolNames}]`)
        // Note if memory was already stored
        if (msg.tool_calls.some((tc) => tc.name === 'memory_set')) {
          lines.push('[Already stored memories via memory_set]')
        }
      } else if (text) {
        const trimmed = text.length > 500 ? `${text.slice(0, 500)}...` : text
        lines.push(`Assistant: ${trimmed}`)
      }
      continue
    }

    if (msg.role === 'tool') {
      if (!text) continue
      // Include more of tool results than the regular extractor — these often
      // contain the exact values (file paths, error messages) we need to keep
      const trimmed = text.length > 800 ? `${text.slice(0, 800)}...` : text
      lines.push(`Tool result (${msg.tool_call_id ?? 'unknown'}): ${trimmed}`)
    }
  }

  return lines.join('\n')
}

/**
 * Parse the LLM's JSON response into validated extraction results.
 */
function parseFlushExtractions(
  content: string,
  maxExtractions: number,
): CompactionExtraction[] {
  let jsonStr = content.trim()

  // Strip markdown code fences if present
  if (jsonStr.startsWith('```')) {
    const lines = jsonStr.split('\n')
    lines.shift()
    if (lines[lines.length - 1]?.trim() === '```') {
      lines.pop()
    }
    jsonStr = lines.join('\n').trim()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    const match = jsonStr.match(/\[[\s\S]*\]/)
    if (!match) {
      log.debug('compaction-flush', 'No valid JSON array in flush response')
      return []
    }
    try {
      parsed = JSON.parse(match[0])
    } catch {
      log.debug('compaction-flush', 'Failed to parse flush JSON')
      return []
    }
  }

  if (!Array.isArray(parsed)) return []

  const validCategories = new Set<string>(['fact', 'preference', 'decision', 'project', 'entity'])
  const results: CompactionExtraction[] = []

  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const { key, value, category } = item as Record<string, unknown>

    if (typeof key !== 'string' || typeof value !== 'string') continue
    if (typeof category !== 'string' || !validCategories.has(category)) continue

    const sanitizedKey = key
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 100)

    if (!sanitizedKey || !value.trim()) continue

    results.push({
      key: sanitizedKey,
      value: value.trim(),
      category: category as MemoryCategory,
    })

    if (results.length >= maxExtractions) break
  }

  return results
}
