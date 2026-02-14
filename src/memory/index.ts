export { MemoryFiles, createMemoryFiles, type MemoryEntry } from './files'
export { MemoryIndexer, createMemoryIndexer, type IndexedMemory, type ContentType } from './indexer'
export { MemorySearch, createMemorySearch, type SearchResult, type SearchOptions } from './search'
export { retrieveForContext, type RetrievalConfig } from './retrieval'
export {
  createEmbeddingProvider,
  Qwen3VLEmbeddings,
  LlamaCppEmbeddings,
  OpenAIEmbeddings,
  type EmbeddingProvider,
  type EmbeddingInput,
  type EmbeddingProviderType,
} from './embeddings'

import { join } from 'path'
import { createMemoryFiles, type MemoryFiles } from './files'
import { createMemoryIndexer, type MemoryIndexer, type ContentType } from './indexer'
import { createMemorySearch, type MemorySearch, type SearchResult } from './search'
import { type EmbeddingProvider, type EmbeddingInput } from './embeddings'
import { log } from '../util/logger'

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
    this.indexer = createMemoryIndexer(
      join(workspaceDir, 'memory.db'),
      embeddingDimensions
    )
    this.embeddings = embeddings ?? null
    this.search = createMemorySearch(this.indexer, embeddings)
  }

  /**
   * Store a text memory
   */
  async set(key: string, value: string): Promise<void> {
    let embedding: Float32Array | undefined

    if (this.embeddings) {
      try {
        const input: EmbeddingInput = { type: 'text', text: value }
        embedding = await this.embeddings.embed(input)
      } catch (error) {
        log.warn('memory', `Failed to generate embedding for ${key}:`, error)
      }
    }

    this.indexer.set(key, value, { contentType: 'text', embedding })
    await this.files.appendToDailyLog(`SET ${key}: ${value.slice(0, 100)}...`)
    log.debug('memory', `Set memory: ${key}`)
  }

  /**
   * Store an image memory
   */
  async setImage(key: string, imageData: string, description?: string): Promise<void> {
    // Store the image file
    const imagePath = await this.files.storeImage(imageData, key)

    // Generate embedding if multimodal embeddings available
    let embedding: Float32Array | undefined
    if (this.embeddings?.supportsImages) {
      try {
        const input: EmbeddingInput = description
          ? { type: 'multimodal', text: description, image: imageData }
          : { type: 'image', image: imageData }
        embedding = await this.embeddings.embed(input)
      } catch (error) {
        log.warn('memory', `Failed to generate image embedding for ${key}:`, error)
      }
    }

    const contentType: ContentType = description ? 'multimodal' : 'image'
    this.indexer.set(key, description ?? `[Image: ${key}]`, {
      contentType,
      imagePath,
      embedding,
    })

    await this.files.appendToDailyLog(`SET_IMAGE ${key}: ${imagePath}`)
    log.debug('memory', `Set image memory: ${key}`)
  }

  /**
   * Store a multimodal memory (text + image)
   */
  async setMultimodal(
    key: string,
    text: string,
    imageData: string
  ): Promise<void> {
    const imagePath = await this.files.storeImage(imageData, key)

    let embedding: Float32Array | undefined
    if (this.embeddings?.supportsImages) {
      try {
        const input: EmbeddingInput = { type: 'multimodal', text, image: imageData }
        embedding = await this.embeddings.embed(input)
      } catch (error) {
        log.warn('memory', `Failed to generate multimodal embedding for ${key}:`, error)
      }
    }

    this.indexer.set(key, text, {
      contentType: 'multimodal',
      imagePath,
      embedding,
    })

    await this.files.appendToDailyLog(`SET_MULTIMODAL ${key}: ${text.slice(0, 50)}...`)
    log.debug('memory', `Set multimodal memory: ${key}`)
  }

  /**
   * Get a memory by key
   */
  get(key: string): { value: string; imagePath?: string } | null {
    const memory = this.indexer.get(key)
    if (!memory) return null

    return {
      value: memory.value,
      imagePath: memory.imagePath,
    }
  }

  /**
   * Get a memory with its image data
   */
  async getWithImage(key: string): Promise<{ value: string; imageData?: string } | null> {
    const memory = this.indexer.get(key)
    if (!memory) return null

    let imageData: string | undefined
    if (memory.imagePath) {
      try {
        imageData = await this.files.readImage(memory.imagePath)
      } catch (error) {
        log.warn('memory', `Failed to read image for ${key}:`, error)
      }
    }

    return {
      value: memory.value,
      imageData,
    }
  }

  /**
   * Search memories by text (FTS)
   */
  async searchText(query: string, limit = 10): Promise<SearchResult[]> {
    return this.search.searchText(query, { limit })
  }

  /**
   * Search memories semantically (vector similarity)
   */
  async searchSemantic(query: string, limit = 10): Promise<SearchResult[]> {
    return this.search.searchSemantic(query, { limit })
  }

  /**
   * Search memories by image similarity
   */
  async searchByImage(imageData: string, limit = 10): Promise<SearchResult[]> {
    return this.search.searchByImage(imageData, { limit })
  }

  /**
   * Hybrid search combining FTS and vector
   */
  async searchHybrid(query: string, limit = 10): Promise<SearchResult[]> {
    return this.search.searchHybrid(query, { limit })
  }

  /**
   * Find memories similar to a given memory
   */
  async findSimilar(key: string, limit = 10): Promise<SearchResult[]> {
    return this.search.findSimilar(key, { limit })
  }

  /**
   * Get all image memories
   */
  getImages(limit = 100): Array<{ key: string; value: string; imagePath?: string }> {
    const memories = this.indexer.getByContentType('image', limit)
    const multimodal = this.indexer.getByContentType('multimodal', limit)

    return [...memories, ...multimodal].map(m => ({
      key: m.key,
      value: m.value,
      imagePath: m.imagePath,
    }))
  }

  /**
   * List all memories with metadata
   */
  list(limit = 100, offset = 0): Array<{ key: string; value: string; contentType: string; updatedAt: number }> {
    return this.indexer.list(limit, offset)
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
   * Check if multimodal embeddings are available
   */
  hasMultimodalEmbeddings(): boolean {
    return this.embeddings?.supportsImages ?? false
  }

  close(): void {
    this.indexer.close()
  }
}

export function createMemoryManager(config: MemoryManagerConfig): MemoryManager {
  return new MemoryManager(config)
}
