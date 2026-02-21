import type { EmbeddingInput, EmbeddingProvider } from './embeddings/index'
import type { ContentType, IndexedMemory, MemoryCategory, MemoryIndexer } from './indexer'

export interface SearchResult {
  memory: IndexedMemory
  score: number
  matchType: 'fts' | 'vector' | 'hybrid'
}

export interface SearchOptions {
  limit?: number
  ftsWeight?: number
  vectorWeight?: number
  contentTypes?: ContentType[] // Filter by content type
  categories?: MemoryCategory[] // Filter by category
  since?: number // Filter by creation time (epoch ms)
  until?: number // Filter by creation time (epoch ms)
}

/**
 * Weights for composite recall scoring.
 *
 * Inspired by Hexis's fast_recall: instead of pure similarity matching,
 * blend multiple signals to surface the most useful memories.
 */
export interface RecallWeights {
  /** Weight for text/vector match quality. Default: 0.50 */
  matchQuality: number
  /** Weight for temporal recency (newer = higher). Default: 0.15 */
  recency: number
  /** Weight for memory importance (0-1 field). Default: 0.15 */
  importance: number
  /** Weight for access frequency (more accessed = more useful). Default: 0.10 */
  accessFrequency: number
  /** Weight for memory confidence (0-1 field). Default: 0.10 */
  confidence: number
}

const DEFAULT_RECALL_WEIGHTS: RecallWeights = {
  matchQuality: 0.5,
  recency: 0.15,
  importance: 0.15,
  accessFrequency: 0.1,
  confidence: 0.1,
}

/**
 * Normalize a BM25 rank (negative, more negative = better) to a [0, 1) score.
 * Uses the formula |rank| / (1 + |rank|) which provides a monotonic mapping
 * where better BM25 matches get higher scores.
 */
function normalizeBM25(rank: number): number {
  const abs = Math.abs(rank)
  return abs / (1 + abs)
}

/**
 * Compute cosine similarity between two vectors
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0
    const bVal = b[i] ?? 0
    dotProduct += aVal * bVal
    normA += aVal * aVal
    normB += bVal * bVal
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB)
  if (magnitude === 0) return 0

  return dotProduct / magnitude
}

/**
 * Compute temporal recency score (0-1).
 * Uses exponential decay: memories from the last hour score ~1.0,
 * memories from a week ago score ~0.3, memories from a month score ~0.1.
 */
function recencyScore(createdAt: number): number {
  const ageMs = Date.now() - createdAt
  const ageHours = ageMs / 3_600_000
  // Half-life of ~48 hours: recent memories are strongly preferred
  return Math.exp(-0.015 * ageHours)
}

/**
 * Normalize access count to 0-1 using logarithmic scaling.
 * 0 accesses = 0, 1 access = 0.3, 10 accesses = 0.7, 100+ = ~1.0
 */
function accessScore(accessCount: number): number {
  if (accessCount <= 0) return 0
  return Math.min(1, Math.log10(accessCount + 1) / 2)
}

/**
 * Compute weighted composite score for a memory given its match quality.
 * Blends match quality with recency, importance, access frequency, and confidence.
 */
function compositeScore(
  matchQuality: number,
  memory: IndexedMemory,
  weights: RecallWeights,
): number {
  return (
    weights.matchQuality * matchQuality +
    weights.recency * recencyScore(memory.createdAt) +
    weights.importance * memory.importance +
    weights.accessFrequency * accessScore(memory.accessCount) +
    weights.confidence * memory.confidence
  )
}

export class MemorySearch {
  private indexer: MemoryIndexer
  private embeddings: EmbeddingProvider | null

  constructor(indexer: MemoryIndexer, embeddings?: EmbeddingProvider) {
    this.indexer = indexer
    this.embeddings = embeddings ?? null
  }

  /**
   * Text-only search using FTS
   */
  async searchText(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 10 } = options

    const ftsResults = this.indexer.searchFTS(query, limit)

    return ftsResults.map((result) => ({
      memory: result.memory,
      score: normalizeBM25(result.rank),
      matchType: 'fts' as const,
    }))
  }

  /**
   * Vector similarity search
   */
  async searchVector(
    queryEmbedding: Float32Array,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const { limit = 10, contentTypes, categories, since, until } = options

    let candidates = this.indexer.getAllWithEmbeddings()

    // Filter by content type if specified
    if (contentTypes && contentTypes.length > 0) {
      candidates = candidates.filter((m) => contentTypes.includes(m.contentType))
    }

    // Filter by category if specified
    if (categories && categories.length > 0) {
      candidates = candidates.filter((m) => categories.includes(m.category))
    }

    // Filter by time range if specified
    if (since !== undefined) {
      candidates = candidates.filter((m) => m.createdAt >= since)
    }
    if (until !== undefined) {
      candidates = candidates.filter((m) => m.createdAt <= until)
    }

    // Compute similarities
    const scored = candidates
      .map((memory) => ({
        memory,
        score: memory.embedding ? cosineSimilarity(queryEmbedding, memory.embedding) : 0,
        matchType: 'vector' as const,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return scored
  }

  /**
   * Search using an image (requires multimodal embeddings)
   */
  async searchByImage(imageUrl: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    if (!this.embeddings || !this.embeddings.supportsImages) {
      throw new Error('Image search requires a multimodal embedding provider')
    }

    const input: EmbeddingInput = { type: 'image', image: imageUrl }
    const queryEmbedding = await this.embeddings.embed(input)

    return this.searchVector(queryEmbedding, options)
  }

  /**
   * Search using text, embedding the query first
   */
  async searchSemantic(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    if (!this.embeddings) {
      // Fall back to FTS if no embeddings available
      return this.searchText(query, options)
    }

    const input: EmbeddingInput = { type: 'text', text: query }
    const queryEmbedding = await this.embeddings.embed(input)

    return this.searchVector(queryEmbedding, options)
  }

  /**
   * Hybrid search combining FTS, vector similarity, and composite recall signals.
   *
   * Inspired by Hexis's fast_recall: blends match quality (FTS + vector) with
   * temporal recency, memory importance, access frequency, and confidence.
   * This surfaces memories that are not just similar but also recent, trusted,
   * and frequently useful.
   */
  async searchHybrid(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 10, ftsWeight = 0.3, vectorWeight = 0.7, categories, since, until } = options

    // Get FTS results
    const ftsResults = await this.searchText(query, { limit: limit * 2 })
    const ftsScoreMap = new Map(ftsResults.map((r) => [r.memory.key, r.score]))

    // Get vector results if embeddings available
    let vectorScoreMap = new Map<string, number>()
    if (this.embeddings) {
      const vectorResults = await this.searchSemantic(query, {
        limit: limit * 2,
        categories,
        since,
        until,
      })
      vectorScoreMap = new Map(vectorResults.map((r) => [r.memory.key, r.score]))
    }

    // Combine scores with composite recall
    const allKeys = new Set([...ftsScoreMap.keys(), ...vectorScoreMap.keys()])
    const combined: SearchResult[] = []

    for (const key of allKeys) {
      const ftsScore = ftsScoreMap.get(key) ?? 0
      const vectorScore = vectorScoreMap.get(key) ?? 0
      const matchQuality = ftsScore * ftsWeight + vectorScore * vectorWeight

      const memory = this.indexer.get(key)
      if (!memory) continue

      // Apply category/time filters to combined results (FTS doesn't filter these)
      if (categories && categories.length > 0 && !categories.includes(memory.category)) continue
      if (since !== undefined && memory.createdAt < since) continue
      if (until !== undefined && memory.createdAt > until) continue

      // Apply weighted composite scoring
      const score = compositeScore(matchQuality, memory, DEFAULT_RECALL_WEIGHTS)

      combined.push({
        memory,
        score,
        matchType: 'hybrid',
      })
    }

    return combined.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /**
   * Find memories similar to a given memory (by embedding)
   */
  async findSimilar(memoryKey: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const memory = this.indexer.get(memoryKey)
    if (!memory?.embedding) {
      throw new Error(`Memory "${memoryKey}" not found or has no embedding`)
    }

    const results = await this.searchVector(memory.embedding, {
      ...options,
      limit: (options.limit ?? 10) + 1, // Get one extra to filter self
    })

    // Filter out the source memory
    return results.filter((r) => r.memory.key !== memoryKey).slice(0, options.limit ?? 10)
  }
}

export function createMemorySearch(
  indexer: MemoryIndexer,
  embeddings?: EmbeddingProvider,
): MemorySearch {
  return new MemorySearch(indexer, embeddings)
}
