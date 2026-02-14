import type { ChatMessage, LLMProvider } from '../providers/types'
import { getTextContent } from '../providers/types'
import { log } from '../util/logger'
import type { MemoryCategory } from './indexer'

export interface ExtractionResult {
  key: string
  value: string
  category: MemoryCategory
}

export interface ExtractorConfig {
  /** Minimum number of user messages before extraction triggers */
  minMessages: number
  /** Maximum extractions per conversation turn */
  maxExtractions: number
}

const DEFAULT_CONFIG: ExtractorConfig = {
  minMessages: 2,
  maxExtractions: 5,
}

const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze the following conversation and extract important facts, preferences, decisions, and project details worth remembering for future conversations.

For each extracted memory, output a JSON array where each item has:
- "key": a short snake_case identifier (e.g., "preferred_language", "api_redesign_decision")
- "value": a concise but complete description of what to remember
- "category": one of "fact", "preference", "decision", "project", "entity"

Categories:
- fact: Concrete information stated by the user (technical details, names, dates)
- preference: User preferences, opinions, or how they like things done
- decision: Decisions made during the conversation about how to proceed
- project: Project state, goals, milestones, architecture choices
- entity: People, services, repos, or other named entities and their relationships

Rules:
- Only extract information that would be useful in future conversations
- Skip trivial small talk, greetings, or transient context
- Be concise — each value should be 1-2 sentences max
- Use specific keys that won't collide (include topic context in the key)
- If there's nothing worth remembering, return an empty array: []
- Do NOT extract information the agent already stored via memory_set tool calls
- Output ONLY the JSON array, no other text

Conversation:
`

/**
 * Extract memorable facts from a conversation turn.
 *
 * Uses the provided LLM to analyze recent messages and identify
 * facts, preferences, decisions, and project details worth persisting.
 * Runs asynchronously after the agent responds — does not block the response.
 */
export async function extractMemories(
  messages: ChatMessage[],
  provider: LLMProvider,
  config: Partial<ExtractorConfig> = {},
): Promise<ExtractionResult[]> {
  const { minMessages, maxExtractions } = { ...DEFAULT_CONFIG, ...config }

  // Only extract if there's enough conversation to be meaningful
  const userMessages = messages.filter((m) => m.role === 'user')
  if (userMessages.length < minMessages) return []

  // Skip if the conversation is mostly tool calls (agent is working, not conversing)
  const toolMessages = messages.filter((m) => m.role === 'tool')
  if (toolMessages.length > messages.length * 0.7) return []

  // Build a condensed view of the conversation (skip tool call details)
  const condensed = condenseForExtraction(messages)
  if (condensed.length < 50) return []

  const prompt = EXTRACTION_PROMPT + condensed

  try {
    const response = await provider.chat({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1024,
    })

    return parseExtractions(response.content, maxExtractions)
  } catch (error) {
    log.warn('extractor', 'Memory extraction failed:', error)
    return []
  }
}

/**
 * Build a condensed conversation transcript suitable for extraction.
 * Strips tool call details and focuses on user/assistant dialogue.
 */
function condenseForExtraction(messages: ChatMessage[]): string {
  const lines: string[] = []

  for (const msg of messages) {
    if (msg.role === 'tool') continue

    const text = getTextContent(msg.content)
    if (!text) continue

    // Skip system messages (memory injections, etc.)
    if (msg.role === 'system') continue

    // For assistant messages with tool calls, note the tools used but skip details
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const toolNames = msg.tool_calls.map((tc) => tc.name).join(', ')
      // Include any thinking/text the assistant produced alongside tool calls
      if (text.trim()) {
        lines.push(`Assistant: ${text.slice(0, 200)}`)
      }
      lines.push(`[Used tools: ${toolNames}]`)
      // Skip memory_set calls — those are already stored
      const hasMemorySet = msg.tool_calls.some((tc) => tc.name === 'memory_set')
      if (hasMemorySet) {
        lines.push('[Already stored memories via memory_set]')
      }
      continue
    }

    const label = msg.role === 'user' ? 'User' : 'Assistant'
    // Cap individual messages to avoid blowing up the extraction prompt
    const trimmed = text.length > 500 ? `${text.slice(0, 500)}...` : text
    lines.push(`${label}: ${trimmed}`)
  }

  return lines.join('\n')
}

/**
 * Parse the LLM's JSON response into validated extraction results.
 */
function parseExtractions(content: string, maxExtractions: number): ExtractionResult[] {
  // Extract JSON array from the response (handle markdown code blocks)
  let jsonStr = content.trim()

  // Strip markdown code fences if present
  if (jsonStr.startsWith('```')) {
    const lines = jsonStr.split('\n')
    // Remove first and last lines (the fences)
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
    // Try to find a JSON array in the response
    const match = jsonStr.match(/\[[\s\S]*\]/)
    if (!match) {
      log.debug('extractor', 'No valid JSON array found in extraction response')
      return []
    }
    try {
      parsed = JSON.parse(match[0])
    } catch {
      log.debug('extractor', 'Failed to parse extracted JSON')
      return []
    }
  }

  if (!Array.isArray(parsed)) return []

  const validCategories = new Set<string>(['fact', 'preference', 'decision', 'project', 'entity'])
  const results: ExtractionResult[] = []

  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const { key, value, category } = item as Record<string, unknown>

    if (typeof key !== 'string' || typeof value !== 'string') continue
    if (typeof category !== 'string' || !validCategories.has(category)) continue

    // Sanitize key: ensure it's a valid snake_case identifier
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
