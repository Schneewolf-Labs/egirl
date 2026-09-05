import { join } from 'path'
import { log } from '../util/logger'
import type { EmbeddingInput, EmbeddingProvider } from './embeddings/index'
import { createMemoryFiles, type MemoryFiles } from './files'
import {
  createMemoryIndexer,
  type MemoryCategory,
  type MemoryIndexer,
  type MemorySource,
} from './indexer'
import {
  createMemorySearch,
  type MemorySearch,
  type SearchOptions,
  type SearchResult,
} from './search'

export { type CompactionExtraction, flushBeforeCompaction } from './compaction-flush'
export {
  createEmbeddingProvider,
  type EmbeddingInput,
  type EmbeddingProvider,
  type EmbeddingProviderType,
  LlamaCppEmbeddings,
  OpenAIEmbeddings,
  Qwen3VLEmbeddings,
} from './embeddings/index'
export { type ExtractionResult, extractMemories } from './extractor'
export { createMemoryFiles, MemoryFiles } from './files'
export { collectGarbage, type GCConfig, type GCResult } from './gc'
export {
  type ContentType,
  createMemoryIndexer,
  type FTSResult,
  type IndexedMemory,
  type MemoryCategory,
  MemoryIndexer,
  type MemorySource,
} from './indexer'
export { chunkDailyLog, indexDailyLogs } from './log-indexer'
export { type RetrievalConfig, retrieveForContext } from './retrieval'
export { createMemorySearch, MemorySearch, type SearchOptions, type SearchResult } from './search'
export { createWorkingMemory, WorkingMemory, type WorkingMemoryEntry } from './working'

export interface MemoryManagerConfig {
  workspaceDir: string
  embeddings?: EmbeddingProvider
  embeddingDimensions?: number
}

export class MemoryManager {
  private files: MemoryFiles
  private indexer: MemoryIndexer
  private search: MemorySearch
  private embeddings: EmbeddingProvider | null

  constructor(config: MemoryManagerConfig) {
    const { workspaceDir, embeddings, embeddingDimensions } = config

    this.files = createMemoryFiles(workspaceDir)
    this.indexer = createMemoryIndexer(join(workspaceDir, 'memory.db'), embeddingDimensions)
    this.embeddings = embeddings ?? null
    this.search = createMemorySearch(this.indexer, embeddings)
  }

  /**
   * Store a text memory
   */
  async set(
    key: string,
    value: string,
    options?: { category?: MemoryCategory; source?: MemorySource; sessionId?: string },
  ): Promise<void> {
    let embedding: Float32Array | undefined

    if (this.embeddings) {
      try {
        const input: EmbeddingInput = { type: 'text', text: value }
        embedding = await this.embeddings.embed(input)
      } catch (error) {
        log.warn('memory', `Failed to generate embedding for ${key}:`, error)
      }
    }

    const actualKey = this.indexer.set(key, value, {
      contentType: 'text',
      embedding,
      category: options?.category,
      source: options?.source,
      sessionId: options?.sessionId,
    })
    await this.files.appendToDailyLog(
      `SET ${actualKey} [${options?.category ?? 'general'}]: ${value.slice(0, 100)}...`,
    )
    log.debug(
      'memory',
      `Set memory: ${actualKey} (category=${options?.category ?? 'general'}, source=${options?.source ?? 'manual'})`,
    )
  }

  /**
   * Get a memory by key
   */
  get(key: string): {
    value: string
    category: MemoryCategory
    source: MemorySource
    createdAt: number
    updatedAt: number
  } | null {
    const memory = this.indexer.get(key)
    if (!memory) return null

    return {
      value: memory.value,
      category: memory.category,
      source: memory.source,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    }
  }

  /**
   * Search memories by text (FTS)
   */
  async searchText(query: string, limit = 10): Promise<SearchResult[]> {
    const results = await this.search.searchText(query, { limit })
    this.trackAccess(results)
    return results
  }

  /**
   * Search memories semantically (vector similarity)
   */
  async searchSemantic(query: string, limit = 10): Promise<SearchResult[]> {
    const results = await this.search.searchSemantic(query, { limit })
    this.trackAccess(results)
    return results
  }

  /**
   * Hybrid search combining FTS and vector
   */
  async searchHybrid(query: string, limit?: number | SearchOptions): Promise<SearchResult[]> {
    const options: SearchOptions = typeof limit === 'number' ? { limit } : (limit ?? {})
    const results = await this.search.searchHybrid(query, options)
    this.trackAccess(results)
    return results
  }

  /**
   * Find memories similar to a given memory
   */
  async findSimilar(key: string, limit = 10): Promise<SearchResult[]> {
    const results = await this.search.findSimilar(key, { limit })
    this.trackAccess(results)
    return results
  }

  private trackAccess(results: SearchResult[]): void {
    if (results.length === 0) return
    this.indexer.recordAccess(results.map((r) => r.memory.key))
  }

  /**
   * List all memories with metadata
   */
  list(
    limit = 100,
    offset = 0,
    filters?: { category?: MemoryCategory; source?: MemorySource; since?: number; until?: number },
  ): Array<{
    key: string
    value: string
    contentType: string
    category: MemoryCategory
    source: MemorySource
    createdAt: number
    updatedAt: number
  }> {
    return this.indexer.list(limit, offset, filters)
  }

  /**
   * Search with category and time-range filters
   */
  async searchFiltered(
    query: string,
    options?: { limit?: number; categories?: MemoryCategory[]; since?: number; until?: number },
  ): Promise<SearchResult[]> {
    const results = await this.search.searchHybrid(query, {
      limit: options?.limit,
      categories: options?.categories,
      since: options?.since,
      until: options?.until,
    })
    this.trackAccess(results)
    return results
  }

  /**
   * Get memories by category
   */
  getByCategory(category: MemoryCategory, limit = 100): SearchResult[] {
    const memories = this.indexer.getByCategory(category, limit)
    return memories.map((m) => ({ memory: m, score: 1, matchType: 'hybrid' as const }))
  }

  /**
   * Get memories within a time range
   */
  getByTimeRange(since: number, until?: number, limit = 100): SearchResult[] {
    const memories = this.indexer.getByTimeRange(since, until, limit)
    return memories.map((m) => ({ memory: m, score: 1, matchType: 'hybrid' as const }))
  }

  /**
   * Count total stored memories
   */
  count(): number {
    return this.indexer.count()
  }

  /**
   * Delete a memory
   */
  delete(key: string): boolean {
    return this.indexer.delete(key)
  }

  /**
   * Check if a value is semantically duplicate of an existing memory.
   * Returns the similar memory's key if above threshold, undefined otherwise.
   * Uses the cached embedding index for fast lookups.
   */
  async checkDuplicate(value: string, threshold = 0.92): Promise<string | undefined> {
    if (!this.embeddings) return undefined

    let queryEmbedding: Float32Array
    try {
      queryEmbedding = await this.embeddings.embed({ type: 'text', text: value })
    } catch {
      return undefined
    }

    const results = await this.search.searchVector(queryEmbedding, { limit: 1 })
    if (results.length > 0 && results[0]?.score !== undefined && results[0].score >= threshold) {
      return results[0].memory.key
    }
    return undefined
  }

  /**
   * Access underlying file operations (for log indexing, etc.)
   */
  getFiles(): MemoryFiles {
    return this.files
  }

  close(): void {
    this.indexer.close()
  }
}

export function createMemoryManager(config: MemoryManagerConfig): MemoryManager {
  return new MemoryManager(config)
}
