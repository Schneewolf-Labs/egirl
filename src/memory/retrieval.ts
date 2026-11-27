import { log } from '../util/logger'
import type { MemoryManager } from './index'
import type { SearchResult } from './search'

export interface RetrievalConfig {
  scoreThreshold: number // Minimum score to include (default 0.35)
  maxResults: number // Max memories to inject (default 5)
  maxTokensBudget: number // Rough char budget for injected context (default 2000)
}

const DEFAULT_CONFIG: RetrievalConfig = {
  scoreThreshold: 0.35,
  maxResults: 5,
  maxTokensBudget: 2000,
}

/** Acknowledgements and continuations: a reply with nothing to search on. */
const ACK =
  '(?:yes|no|ok|okay|k|kk|sure|thanks|thank you|thx|ty|hi|hello|hey|heya|hiya|yo|sup|morning|good morning|evening|good evening|continue|go|go on|go ahead|proceed|lgtm|sounds good|nice|cool|great|good|yep|yeah|nah|nope|done|next|\\+1)'

/** Greetings and thanks: the words a message addresses the agent by name with. */
const SALUTATION =
  '(?:hi|hello|hey|heya|hiya|yo|sup|morning|good morning|evening|good evening|thanks|thank you|thx|ty)'

/** A single word that would turn "hey <word>" into a question or an instruction. */
const NOT_A_NAME =
  "(?:what|what's|whats|why|how|when|where|who|which|but|and|so|now|then|please|can|could|would|will|is|are|do|does|did)"

const SEP = '[\\s,.!?…]+'
const END = '[.!?…\\s]*$'

/**
 * Whole-message matches only. Acks may repeat or combine ("yo yo", "ok cool"); a greeting or
 * thanks may be followed by one vocative word ("hey juno", "thanks Kira!"). Any further
 * content makes the turn non-trivial.
 */
const ONLY_ACKS_RE = new RegExp(`^${ACK}(?:${SEP}${ACK})*${END}`, 'i')
const VOCATIVE_RE = new RegExp(
  `^(?:${ACK}${SEP})*${SALUTATION}${SEP}(?!${NOT_A_NAME}${END})[\\p{L}][\\p{L}'-]*${END}`,
  'iu',
)

/** Longest a greeting with a vocative may run: "ok thanks juno" yes, a sentence no. */
const MAX_TRIVIAL_WORDS = 4

/** True when a message carries no semantic signal worth a recall round-trip. */
export function isTrivialPrompt(text: string): boolean {
  const trimmed = text.trim()
  if (ONLY_ACKS_RE.test(trimmed)) return true
  return trimmed.split(/\s+/).length <= MAX_TRIVIAL_WORDS && VOCATIVE_RE.test(trimmed)
}

/**
 * Proactively retrieve memories relevant to a user message.
 *
 * Runs hybrid search against the memory store and returns a formatted
 * context block suitable for injection into the conversation. Returns
 * undefined when nothing relevant is found.
 *
 * This is lightweight by design — a single hybrid search call using the
 * existing MemoryManager. No additional embedding calls beyond what
 * searchHybrid already does.
 */
export async function retrieveForContext(
  query: string,
  memory: MemoryManager,
  config: Partial<RetrievalConfig> = {},
  options: { isHarnessTurn?: boolean } = {},
): Promise<string | undefined> {
  // The harness wrote this turn (/continue, a resume note, a corrective nudge), not the
  // principal. Its text is boilerplate that matches whatever is stored, and the run it
  // continues already carries its own context: recalled junk under it drives the reply.
  if (options.isHarnessTurn) return undefined

  const { scoreThreshold, maxResults, maxTokensBudget } = {
    ...DEFAULT_CONFIG,
    ...config,
  }

  // Skip very short queries that won't produce meaningful results
  if (query.trim().length < 3) return undefined

  // A turn with no semantic signal gets no recall: the search round-trip is wasted, and
  // injecting stale context under a one-word reply can derail it (hermes-agent's
  // trivial-prompt gate). Anchored so "ok, but what about the header?" still retrieves.
  if (isTrivialPrompt(query)) return undefined

  let results: SearchResult[]
  try {
    results = await memory.searchHybrid(query, maxResults)
  } catch (error) {
    log.warn('retrieval', 'Proactive memory search failed:', error)
    return undefined
  }

  // Filter by score threshold
  const relevant = results.filter((r) => r.score >= scoreThreshold)

  if (relevant.length === 0) return undefined

  // Build context block, respecting token budget
  const lines: string[] = []
  let charCount = 0

  for (const r of relevant) {
    const value = r.memory.value
    const preview = value.length > 300 ? `${value.slice(0, 300)}...` : value
    const age = formatAge(r.memory.createdAt)
    const cat = r.memory.category !== 'general' ? `${r.memory.category}, ` : ''
    const line = `- [${r.memory.key}] (${cat}${age}): ${preview}`

    if (charCount + line.length > maxTokensBudget) break

    lines.push(line)
    charCount += line.length
  }

  if (lines.length === 0) return undefined

  log.debug('retrieval', `Injecting ${lines.length} memories for: "${query.slice(0, 60)}"`)

  return `[Recalled memories relevant to this message:\n${lines.join('\n')}]`
}

function formatAge(timestamp: number): string {
  const now = Date.now()
  const diffMs = now - timestamp
  const diffMins = Math.floor(diffMs / 60_000)
  const diffHours = Math.floor(diffMs / 3_600_000)
  const diffDays = Math.floor(diffMs / 86_400_000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  return new Date(timestamp).toISOString().slice(0, 10)
}
