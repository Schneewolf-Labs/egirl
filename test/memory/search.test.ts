import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { EmbeddingInput, EmbeddingProvider } from '../../src/memory/embeddings'
import { MemoryIndexer } from '../../src/memory/indexer'
import { MemorySearch } from '../../src/memory/search'

// Minimal mock embedding provider that returns predictable vectors
function createMockEmbeddingProvider(dimensions = 4): EmbeddingProvider {
  return {
    name: 'mock',
    dimensions,
    supportsImages: false,

    async embed(input: EmbeddingInput): Promise<Float32Array> {
      // Generate a deterministic vector from the text content
      const text = input.type === 'text' ? input.text : 'image'
      const vec = new Float32Array(dimensions)
      for (let i = 0; i < dimensions; i++) {
        vec[i] = (text.charCodeAt(i % text.length) % 100) / 100
      }
      // Normalize
      let norm = 0
      for (let i = 0; i < dimensions; i++) {
        norm += (vec[i] ?? 0) * (vec[i] ?? 0)
      }
      norm = Math.sqrt(norm)
      if (norm > 0) {
        for (let i = 0; i < dimensions; i++) {
          vec[i] = (vec[i] ?? 0) / norm
        }
      }
      return vec
    },

    async embedBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
      return Promise.all(inputs.map((input) => this.embed(input)))
    },
  }
}

describe('MemorySearch', () => {
  let tmpDir: string
  let indexer: MemoryIndexer
  let embeddings: EmbeddingProvider

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'egirl-search-test-'))
    const dbPath = join(tmpDir, 'test.db')
    indexer = new MemoryIndexer(dbPath, 4)
    embeddings = createMockEmbeddingProvider(4)
  })

  afterEach(() => {
    indexer.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('searchText (FTS)', () => {
    test('finds memories by keyword', async () => {
      indexer.set('greeting', 'hello world')
      indexer.set('farewell', 'goodbye world')
      indexer.set('unrelated', 'typescript is great')

      const search = new MemorySearch(indexer)
      const results = await search.searchText('world')

      expect(results.length).toBe(2)
      expect(results.every((r) => r.matchType === 'fts')).toBe(true)
    })

    test('returns empty for no matches', async () => {
      indexer.set('greeting', 'hello world')

      const search = new MemorySearch(indexer)
      const results = await search.searchText('nonexistent')

      expect(results.length).toBe(0)
    })

    test('scores are between 0 and 1', async () => {
      indexer.set('a', 'test query match')
      indexer.set('b', 'another test query')

      const search = new MemorySearch(indexer)
      const results = await search.searchText('test query')

      for (const r of results) {
        expect(r.score).toBeGreaterThan(0)
        expect(r.score).toBeLessThanOrEqual(1)
      }
    })

    test('respects limit', async () => {
      for (let i = 0; i < 20; i++) {
        indexer.set(`item-${i}`, `searchable content number ${i}`)
      }

      const search = new MemorySearch(indexer)
      const results = await search.searchText('searchable', { limit: 5 })

      expect(results.length).toBe(5)
    })
  })

  describe('searchVector', () => {
    test('finds similar vectors', async () => {
      const vec1 = new Float32Array([1, 0, 0, 0])
      const vec2 = new Float32Array([0.9, 0.1, 0, 0])
      const vec3 = new Float32Array([0, 0, 0, 1])

      indexer.set('similar', 'similar item', { embedding: vec1 })
      indexer.set('close', 'close item', { embedding: vec2 })
      indexer.set('different', 'different item', { embedding: vec3 })

      const search = new MemorySearch(indexer)
      const queryVec = new Float32Array([1, 0, 0, 0])
      const results = await search.searchVector(queryVec, { limit: 3 })

      expect(results.length).toBe(3)
      // First result should be the exact match
      expect(results[0]?.memory.key).toBe('similar')
      expect(results[0]?.score).toBeCloseTo(1.0, 4)
    })

    test('returns results sorted by similarity', async () => {
      const search = new MemorySearch(indexer)

      indexer.set('a', 'a', { embedding: new Float32Array([1, 0, 0, 0]) })
      indexer.set('b', 'b', { embedding: new Float32Array([0.5, 0.5, 0, 0]) })
      indexer.set('c', 'c', { embedding: new Float32Array([0, 1, 0, 0]) })

      const query = new Float32Array([1, 0, 0, 0])
      const results = await search.searchVector(query)

      // Should be sorted by descending similarity
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]?.score).toBeGreaterThanOrEqual(results[i]?.score)
      }
    })
  })

  describe('searchSemantic', () => {
    test('falls back to FTS when no embeddings available', async () => {
      indexer.set('item', 'semantic search test')

      const search = new MemorySearch(indexer) // no embeddings
      const results = await search.searchSemantic('semantic')

      expect(results.length).toBe(1)
      expect(results[0]?.matchType).toBe('fts')
    })

    test('uses embeddings when available', async () => {
      const embedding = await embeddings.embed({ type: 'text', text: 'hello' })
      indexer.set('item', 'hello world', { embedding })

      const search = new MemorySearch(indexer, embeddings)
      const results = await search.searchSemantic('hello')

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0]?.matchType).toBe('vector')
    })
  })

  describe('searchHybrid', () => {
    test('combines FTS and vector results', async () => {
      const embedding = await embeddings.embed({ type: 'text', text: 'typescript' })
      indexer.set('ts-fact', 'typescript is a typed language', { embedding })
      indexer.set('js-fact', 'javascript is dynamically typed')

      const search = new MemorySearch(indexer, embeddings)
      const results = await search.searchHybrid('typescript')

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0]?.matchType).toBe('hybrid')
    })

    test('works without embeddings (FTS only)', async () => {
      indexer.set('item', 'hybrid fallback test')

      const search = new MemorySearch(indexer) // no embeddings
      const results = await search.searchHybrid('hybrid')

      expect(results.length).toBe(1)
      expect(results[0]?.matchType).toBe('hybrid')
    })

    test('deduplicates results by key', async () => {
      const embedding = await embeddings.embed({ type: 'text', text: 'unique' })
      indexer.set('unique-item', 'unique searchable content', { embedding })

      const search = new MemorySearch(indexer, embeddings)
      const results = await search.searchHybrid('unique')

      // Should not have duplicate keys
      const keys = results.map((r) => r.memory.key)
      expect(new Set(keys).size).toBe(keys.length)
    })

    test('respects custom weights', async () => {
      const embedding = await embeddings.embed({ type: 'text', text: 'weighted' })
      indexer.set('weighted', 'weighted search test', { embedding })

      const search = new MemorySearch(indexer, embeddings)

      // FTS-heavy
      const ftsHeavy = await search.searchHybrid('weighted', { ftsWeight: 0.9, vectorWeight: 0.1 })
      // Vector-heavy
      const vecHeavy = await search.searchHybrid('weighted', { ftsWeight: 0.1, vectorWeight: 0.9 })

      // Both should find the item but with different scores
      expect(ftsHeavy.length).toBeGreaterThanOrEqual(1)
      expect(vecHeavy.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('findSimilar', () => {
    test('finds memories similar to a given key', async () => {
      const vec1 = new Float32Array([1, 0, 0, 0])
      const vec2 = new Float32Array([0.95, 0.05, 0, 0])
      const vec3 = new Float32Array([0, 0, 0, 1])

      indexer.set('source', 'source item', { embedding: vec1 })
      indexer.set('similar', 'similar item', { embedding: vec2 })
      indexer.set('different', 'different item', { embedding: vec3 })

      const search = new MemorySearch(indexer)
      const results = await search.findSimilar('source')

      // Should not include the source item itself
      expect(results.every((r) => r.memory.key !== 'source')).toBe(true)
      // The similar item should rank first
      expect(results[0]?.memory.key).toBe('similar')
    })

    test('throws when key not found', async () => {
      const search = new MemorySearch(indexer)

      await expect(search.findSimilar('nonexistent')).rejects.toThrow('not found')
    })

    test('throws when memory has no embedding', async () => {
      indexer.set('no-embed', 'no embedding here')

      const search = new MemorySearch(indexer)

      await expect(search.findSimilar('no-embed')).rejects.toThrow('no embedding')
    })
  })
})
