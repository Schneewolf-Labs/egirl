import { describe, test, expect } from 'bun:test'
import { retrieveForContext } from '../../src/memory/retrieval'
import type { MemoryManager } from '../../src/memory'
import type { SearchResult } from '../../src/memory/search'

/** Create a fake MemoryManager with canned search results */
function mockMemory(results: SearchResult[]): MemoryManager {
  return {
    searchHybrid: async (_query: string, _limit?: number) => results,
  } as unknown as MemoryManager
}

function makeResult(key: string, value: string, score: number): SearchResult {
  return {
    memory: {
      id: 1,
      key,
      value,
      contentType: 'text',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    score,
    matchType: 'hybrid',
  }
}

describe('retrieveForContext', () => {
  test('returns undefined when no results match threshold', async () => {
    const memory = mockMemory([
      makeResult('low-score', 'not relevant', 0.1),
    ])

    const result = await retrieveForContext('test query', memory, {
      scoreThreshold: 0.35,
      maxResults: 5,
      maxTokensBudget: 2000,
    })

    expect(result).toBeUndefined()
  })

  test('returns formatted context for relevant memories', async () => {
    const memory = mockMemory([
      makeResult('project-goal', 'Build a local-first AI agent', 0.8),
      makeResult('user-name', 'Alice', 0.6),
    ])

    const result = await retrieveForContext('what is the project?', memory)

    expect(result).toBeDefined()
    expect(result).toContain('[Recalled memories')
    expect(result).toContain('project-goal')
    expect(result).toContain('Build a local-first AI agent')
    expect(result).toContain('user-name')
    expect(result).toContain('Alice')
  })

  test('respects score threshold', async () => {
    const memory = mockMemory([
      makeResult('high', 'important', 0.9),
      makeResult('medium', 'okay', 0.4),
      makeResult('low', 'irrelevant', 0.1),
    ])

    const result = await retrieveForContext('query', memory, {
      scoreThreshold: 0.5,
      maxResults: 10,
      maxTokensBudget: 2000,
    })

    expect(result).toBeDefined()
    expect(result).toContain('high')
    expect(result).not.toContain('medium')
    expect(result).not.toContain('low')
  })

  test('respects token budget', async () => {
    const longValue = 'x'.repeat(250)
    const memory = mockMemory([
      makeResult('first', longValue, 0.9),
      makeResult('second', longValue, 0.8),
      makeResult('third', longValue, 0.7),
    ])

    const result = await retrieveForContext('query', memory, {
      scoreThreshold: 0.3,
      maxResults: 10,
      maxTokensBudget: 500,
    })

    expect(result).toBeDefined()
    // Budget is 500 chars — first entry is ~260 chars, second would exceed
    expect(result).toContain('first')
    // Third should be cut off by budget
    expect(result).not.toContain('third')
  })

  test('returns undefined for very short queries', async () => {
    const memory = mockMemory([
      makeResult('whatever', 'content', 0.9),
    ])

    const result = await retrieveForContext('hi', memory)
    expect(result).toBeUndefined()
  })

  test('returns undefined when search returns empty', async () => {
    const memory = mockMemory([])

    const result = await retrieveForContext('some query', memory)
    expect(result).toBeUndefined()
  })

  test('handles search errors gracefully', async () => {
    const memory = {
      searchHybrid: async () => { throw new Error('connection refused') },
    } as unknown as MemoryManager

    const result = await retrieveForContext('test query', memory)
    expect(result).toBeUndefined()
  })

  test('truncates long memory values in output', async () => {
    const longValue = 'a'.repeat(500)
    const memory = mockMemory([
      makeResult('long-mem', longValue, 0.9),
    ])

    const result = await retrieveForContext('query', memory)

    expect(result).toBeDefined()
    expect(result).toContain('...')
    // Value should be capped at 300 chars + "..."
    expect(result!.length).toBeLessThan(500)
  })
})
