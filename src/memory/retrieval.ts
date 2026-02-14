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
): Promise<string | undefined> {
  const { scoreThreshold, maxResults, maxTokensBudget } = {
    ...DEFAULT_CONFIG,
    ...config,
  }

  // Skip very short queries that won't produce meaningful results
  if (query.trim().length < 3) return undefined

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
