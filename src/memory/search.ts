import type { MemoryIndexer, IndexedMemory } from './indexer'

export interface SearchResult {
  memory: IndexedMemory
  score: number
  matchType: 'fts' | 'vector' | 'hybrid'
}

export interface SearchOptions {
  limit?: number
  ftsWeight?: number
  vectorWeight?: number
}

export class MemorySearch {
  private indexer: MemoryIndexer

  constructor(indexer: MemoryIndexer) {
    this.indexer = indexer
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 10, ftsWeight = 0.5, vectorWeight = 0.5 } = options

    // For now, only FTS search is implemented
    const ftsResults = this.indexer.searchFTS(query, limit)

    return ftsResults.map((memory, index) => ({
      memory,
      score: 1 - (index / ftsResults.length),  // Simple rank-based score
      matchType: 'fts' as const,
    }))
  }

  async hybridSearch(
    query: string,
    queryEmbedding: Float32Array,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    // TODO: Implement hybrid search combining FTS and vector similarity
    // For now, fall back to FTS only
    return this.search(query, options)
  }
}

export function createMemorySearch(indexer: MemoryIndexer): MemorySearch {
  return new MemorySearch(indexer)
}
