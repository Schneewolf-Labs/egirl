import type { Tool, ToolResult } from '../types'
import type { MemoryManager, SearchResult } from '../../memory'
import { log } from '../../util/logger'

/**
 * Create memory tools with access to a MemoryManager instance.
 * Uses factory pattern to inject the dependency.
 */
export function createMemoryTools(memory: MemoryManager): {
  memorySearchTool: Tool
  memoryGetTool: Tool
  memorySetTool: Tool
} {
  const memorySearchTool: Tool = {
    definition: {
      name: 'memory_search',
      description:
        'Search through stored memories using hybrid search (combines keyword and semantic similarity). Returns the most relevant memories for a given query.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query - can be a question, keywords, or natural language description',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 10)',
          },
        },
        required: ['query'],
      },
    },

    async execute(params: Record<string, unknown>, _cwd: string): Promise<ToolResult> {
      const query = params.query as string
      const limit = (params.limit as number) ?? 10

      try {
        const results = await memory.searchHybrid(query, limit)

        if (results.length === 0) {
          return {
            success: true,
            output: `No memories found for query: "${query}"`,
          }
        }

        const formatted = formatSearchResults(results)
        return {
          success: true,
          output: `Found ${results.length} memories:\n\n${formatted}`,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('memory', `Search failed for "${query}":`, error)
        return {
          success: false,
          output: `Memory search failed: ${message}`,
        }
      }
    },
  }

  const memoryGetTool: Tool = {
    definition: {
      name: 'memory_get',
      description: 'Retrieve a specific memory by its exact key',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'The exact memory key to retrieve',
          },
        },
        required: ['key'],
      },
    },

    async execute(params: Record<string, unknown>, _cwd: string): Promise<ToolResult> {
      const key = params.key as string

      try {
        const result = memory.get(key)

        if (!result) {
          return {
            success: false,
            output: `Memory not found: "${key}"`,
          }
        }

        let output = `Memory [${key}]:\n${result.value}`
        if (result.imagePath) {
          output += `\n\n[Image: ${result.imagePath}]`
        }

        return {
          success: true,
          output,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('memory', `Get failed for "${key}":`, error)
        return {
          success: false,
          output: `Memory retrieval failed: ${message}`,
        }
      }
    },
  }

  const memorySetTool: Tool = {
    definition: {
      name: 'memory_set',
      description:
        'Store a new memory or update an existing one. Use this to remember important facts, user preferences, or context for future conversations.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              'A unique identifier for this memory (e.g., "user_name", "project_goal", "meeting_2024-01-15")',
          },
          value: {
            type: 'string',
            description: 'The content to remember',
          },
        },
        required: ['key', 'value'],
      },
    },

    async execute(params: Record<string, unknown>, _cwd: string): Promise<ToolResult> {
      const key = params.key as string
      const value = params.value as string

      try {
        await memory.set(key, value)

        return {
          success: true,
          output: `Memory stored: "${key}"`,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('memory', `Set failed for "${key}":`, error)
        return {
          success: false,
          output: `Failed to store memory: ${message}`,
        }
      }
    },
  }

  return { memorySearchTool, memoryGetTool, memorySetTool }
}

/**
 * Format search results for display
 */
function formatSearchResults(results: SearchResult[]): string {
  return results
    .map((r, i) => {
      const score = r.score.toFixed(3)
      const value = r.memory.value
      const preview = value.length > 200 ? value.slice(0, 200) + '...' : value
      const imageNote = r.memory.imagePath ? ` [has image]` : ''
      return `${i + 1}. [${r.memory.key}] (score: ${score})${imageNote}\n   ${preview}`
    })
    .join('\n\n')
}

// Stub exports for backward compatibility when MemoryManager isn't available
export const memorySearchTool: Tool = {
  definition: {
    name: 'memory_search',
    description: 'Search through stored memories using semantic search',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        limit: { type: 'number', description: 'Maximum results (default: 10)' },
      },
      required: ['query'],
    },
  },
  async execute(): Promise<ToolResult> {
    return {
      success: false,
      output: 'Memory system not initialized. Start egirl with embeddings configured.',
    }
  },
}

export const memoryGetTool: Tool = {
  definition: {
    name: 'memory_get',
    description: 'Retrieve a specific memory by key',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The memory key to retrieve' },
      },
      required: ['key'],
    },
  },
  async execute(): Promise<ToolResult> {
    return {
      success: false,
      output: 'Memory system not initialized. Start egirl with embeddings configured.',
    }
  },
}
