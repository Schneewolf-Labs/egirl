export { MemoryFiles, createMemoryFiles, type MemoryEntry } from './files'
export { MemoryIndexer, createMemoryIndexer, type IndexedMemory } from './indexer'
export { MemorySearch, createMemorySearch, type SearchResult, type SearchOptions } from './search'
export {
  createEmbeddingProvider,
  OllamaEmbeddings,
  OpenAIEmbeddings,
  type EmbeddingProvider,
} from './embeddings'

import { join } from 'path'
import { createMemoryFiles, type MemoryFiles } from './files'
import { createMemoryIndexer, type MemoryIndexer } from './indexer'
import { createMemorySearch, type MemorySearch, type SearchResult } from './search'
import { log } from '../utils/logger'

export class MemoryManager {
  private files: MemoryFiles
  private indexer: MemoryIndexer
  private search: MemorySearch

  constructor(workspaceDir: string) {
    this.files = createMemoryFiles(workspaceDir)
    this.indexer = createMemoryIndexer(join(workspaceDir, 'memory.db'))
    this.search = createMemorySearch(this.indexer)
  }

  async set(key: string, value: string): Promise<void> {
    this.indexer.set(key, value)
    await this.files.appendToDailyLog(`SET ${key}: ${value.slice(0, 100)}...`)
    log.debug('memory', `Set memory: ${key}`)
  }

  get(key: string): string | null {
    const memory = this.indexer.get(key)
    return memory?.value ?? null
  }

  async searchMemories(query: string, limit = 10): Promise<SearchResult[]> {
    return this.search.search(query, { limit })
  }

  delete(key: string): boolean {
    return this.indexer.delete(key)
  }

  close(): void {
    this.indexer.close()
  }
}

export function createMemoryManager(workspaceDir: string): MemoryManager {
  return new MemoryManager(workspaceDir)
}
