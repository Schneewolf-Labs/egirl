import type { MemoryIndexer, IndexedMemory, ContentType, MemoryCategory } from './indexer'
import type { EmbeddingProvider, EmbeddingInput } from './embeddings/index'

export interface SearchResult {
  memory: IndexedMemory
  score: number
  matchType: 'fts' | 'vector' | 'hybrid'
}

export interface SearchOptions {
  limit?: number
  ftsWeight?: number
  vectorWeight?: number
  contentTypes?: ContentType[]  // Filter by content type
  categories?: MemoryCategory[]  // Filter by category
  since?: number  // Filter by creation time (epoch ms)
  until?: number  // Filter by creation time (epoch ms)
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

    return ftsResults.map((memory, index) => ({
      memory,
      score: 1 - index / ftsResults.length, // Rank-based score
      matchType: 'fts' as const,
    }))
  }

  /**
   * Vector similarity search
   */
  async searchVector(
    queryEmbedding: Float32Array,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const { limit = 10, contentTypes, categories, since, until } = options

    let candidates = this.indexer.getAllWithEmbeddings()

    // Filter by content type if specified
    if (contentTypes && contentTypes.length > 0) {
      candidates = candidates.filter(m => contentTypes.includes(m.contentType))
    }

    // Filter by category if specified
    if (categories && categories.length > 0) {
      candidates = candidates.filter(m => categories.includes(m.category))
    }

    // Filter by time range if specified
    if (since !== undefined) {
      candidates = candidates.filter(m => m.createdAt >= since)
    }
    if (until !== undefined) {
      candidates = candidates.filter(m => m.createdAt <= until)
    }

    // Compute similarities
    const scored = candidates
      .map(memory => ({
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
  async searchByImage(
    imageUrl: string,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
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
  async searchSemantic(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    if (!this.embeddings) {
      // Fall back to FTS if no embeddings available
      return this.searchText(query, options)
    }

    const input: EmbeddingInput = { type: 'text', text: query }
    const queryEmbedding = await this.embeddings.embed(input)

    return this.searchVector(queryEmbedding, options)
  }

  /**
   * Hybrid search combining FTS and vector similarity
   */
  async searchHybrid(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const { limit = 10, ftsWeight = 0.3, vectorWeight = 0.7, categories, since, until } = options

    // Get FTS results
    const ftsResults = await this.searchText(query, { limit: limit * 2 })
    const ftsScoreMap = new Map(ftsResults.map(r => [r.memory.key, r.score]))

    // Get vector results if embeddings available
    let vectorScoreMap = new Map<string, number>()
    if (this.embeddings) {
      const vectorResults = await this.searchSemantic(query, { limit: limit * 2, categories, since, until })
      vectorScoreMap = new Map(vectorResults.map(r => [r.memory.key, r.score]))
    }

    // Combine scores
    const allKeys = new Set([...ftsScoreMap.keys(), ...vectorScoreMap.keys()])
    const combined: SearchResult[] = []

    for (const key of allKeys) {
      const ftsScore = ftsScoreMap.get(key) ?? 0
      const vectorScore = vectorScoreMap.get(key) ?? 0
      const hybridScore = ftsScore * ftsWeight + vectorScore * vectorWeight

      const memory = this.indexer.get(key)
      if (!memory) continue

      // Apply category/time filters to combined results (FTS doesn't filter these)
      if (categories && categories.length > 0 && !categories.includes(memory.category)) continue
      if (since !== undefined && memory.createdAt < since) continue
      if (until !== undefined && memory.createdAt > until) continue

      combined.push({
        memory,
        score: hybridScore,
        matchType: 'hybrid',
      })
    }

    return combined.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /**
   * Find memories similar to a given memory (by embedding)
   */
  async findSimilar(
    memoryKey: string,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const memory = this.indexer.get(memoryKey)
    if (!memory?.embedding) {
      throw new Error(`Memory "${memoryKey}" not found or has no embedding`)
    }

    const results = await this.searchVector(memory.embedding, {
      ...options,
      limit: (options.limit ?? 10) + 1, // Get one extra to filter self
    })

    // Filter out the source memory
    return results.filter(r => r.memory.key !== memoryKey).slice(0, options.limit ?? 10)
  }
}

export function createMemorySearch(
  indexer: MemoryIndexer,
  embeddings?: EmbeddingProvider
): MemorySearch {
  return new MemorySearch(indexer, embeddings)
}
