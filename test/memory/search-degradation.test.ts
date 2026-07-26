import { beforeEach, describe, expect, test } from 'bun:test'
import type { EmbeddingInput, EmbeddingProvider } from '../../src/memory/embeddings/index'
import { MemoryIndexer } from '../../src/memory/indexer'
import { MemorySearch } from '../../src/memory/search'

/**
 * A configured-but-unreachable embedding service used to be strictly worse than no embedding
 * service: none configured returned FTS results, but a failing one threw out of searchHybrid
 * and the caller turned that into "no memory at all". These pin the fallback.
 */

class BrokenEmbeddings implements EmbeddingProvider {
  readonly dimensions = 4
  calls = 0
  async embed(_input: EmbeddingInput): Promise<Float32Array> {
    this.calls++
    throw new Error('connect ECONNREFUSED 127.0.0.1:8082')
  }
  async embedBatch(_inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    this.calls++
    throw new Error('connect ECONNREFUSED 127.0.0.1:8082')
  }
}

class WorkingEmbeddings implements EmbeddingProvider {
  readonly dimensions = 4
  async embed(input: EmbeddingInput): Promise<Float32Array> {
    const text = input.type === 'text' ? input.text : ''
    // deterministic, content-dependent so similarity is not uniform
    const v = new Float32Array(4)
    for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i) / 1000
    return v
  }
  async embedBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    return Promise.all(inputs.map((i) => this.embed(i)))
  }
}

function seed(indexer: MemoryIndexer) {
  indexer.set('pref', 'user prefers terse answers about caching', { category: 'preference' })
  indexer.set('other', 'unrelated note about gardening', { category: 'general' })
}

describe('searchHybrid degradation', () => {
  let indexer: MemoryIndexer

  beforeEach(() => {
    indexer = new MemoryIndexer(':memory:')
    seed(indexer)
  })

  test('with no embeddings configured, keyword results still come back', async () => {
    const search = new MemorySearch(indexer)
    const r = await search.searchHybrid('caching')
    expect(r.length).toBeGreaterThan(0)
  })

  test('a FAILING embedding service degrades to keyword search instead of returning nothing', async () => {
    const broken = new BrokenEmbeddings()
    const search = new MemorySearch(indexer, broken)
    const r = await search.searchHybrid('caching')
    expect(broken.calls).toBeGreaterThan(0) // it really did try
    expect(r.length).toBeGreaterThan(0) // and we still got FTS hits
    expect(r.some((x) => x.memory.key === 'pref')).toBe(true)
  })

  test('a failing embedding service does not throw', async () => {
    const search = new MemorySearch(indexer, new BrokenEmbeddings())
    await expect(search.searchHybrid('caching')).resolves.toBeDefined()
  })

  test('consecutive failures are counted so the degradation is observable', async () => {
    const search = new MemorySearch(indexer, new BrokenEmbeddings())
    expect(search.semanticFailureCount).toBe(0)
    await search.searchHybrid('caching')
    await search.searchHybrid('caching')
    expect(search.semanticFailureCount).toBe(2)
  })

  test('the counter resets once the service recovers', async () => {
    const search = new MemorySearch(indexer, new BrokenEmbeddings())
    await search.searchHybrid('caching')
    expect(search.semanticFailureCount).toBe(1)
    // swap in a working provider the way a restarted service would behave
    const recovered = new MemorySearch(indexer, new WorkingEmbeddings())
    await recovered.searchHybrid('caching')
    expect(recovered.semanticFailureCount).toBe(0)
  })

  test('a working embedding service is still used', async () => {
    const search = new MemorySearch(indexer, new WorkingEmbeddings())
    const r = await search.searchHybrid('caching')
    expect(r.length).toBeGreaterThan(0)
    expect(search.semanticFailureCount).toBe(0)
  })
})
