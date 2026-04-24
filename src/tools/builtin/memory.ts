import type { MemoryCategory, MemoryManager, SearchResult } from '../../memory'
import { log } from '../../util/logger'
import type { Tool, ToolResult } from '../types'

const VALID_CATEGORIES = [
  'general',
  'fact',
  'preference',
  'decision',
  'project',
  'entity',
  'conversation',
  'lesson',
] as const

/** Wrap a tool's logic with uniform error handling: log + surface message as failure result. */
async function runSafely(
  label: string,
  detail: string,
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('memory', `${label} failed${detail ? ` for "${detail}"` : ''}:`, error)
    return { success: false, output: `${label} failed: ${message}` }
  }
}

function isValidCategory(c: unknown): c is MemoryCategory {
  return typeof c === 'string' && VALID_CATEGORIES.includes(c as MemoryCategory)
}

/**
 * Create memory tools with access to a MemoryManager instance.
 * Uses factory pattern to inject the dependency.
 */
export function createMemoryTools(memory: MemoryManager): {
  memorySearchTool: Tool
  memoryGetTool: Tool
  memorySetTool: Tool
  memoryDeleteTool: Tool
  memoryListTool: Tool
  memoryRecallTool: Tool
} {
  const memorySearchTool: Tool = {
    definition: {
      name: 'memory_search',
      description:
        'Search through stored memories using hybrid search (combines keyword and semantic similarity). Supports filtering by category and time range.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query — a question, keywords, or natural language',
          },
          limit: { type: 'number', description: 'Max results (default: 10)' },
          category: {
            type: 'string',
            description: `Filter by category: ${VALID_CATEGORIES.join(', ')}`,
          },
          since: {
            type: 'string',
            description: 'Only include memories created after this date (ISO or "3 days ago")',
          },
        },
        required: ['query'],
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const query = params.query as string
      const limit = (params.limit as number) ?? 10
      const category = params.category as string | undefined
      const since = params.since as string | undefined

      return runSafely('Memory search', query, async () => {
        const categories = isValidCategory(category) ? [category] : undefined
        const sinceTs = since ? parseTimeExpression(since) : undefined

        const results = await memory.searchFiltered(query, { limit, categories, since: sinceTs })

        if (results.length === 0) {
          return {
            success: true,
            output: `No memories found for query: "${query}"${category ? ` (category: ${category})` : ''}${since ? ` (since: ${since})` : ''}`,
          }
        }
        return {
          success: true,
          output: `Found ${results.length} memories:\n\n${formatSearchResults(results)}`,
        }
      })
    },
  }

  const memoryGetTool: Tool = {
    definition: {
      name: 'memory_get',
      description:
        'Retrieve a specific memory by its exact key. Returns value, category, source, and timestamps.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'The exact memory key to retrieve' } },
        required: ['key'],
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const key = params.key as string
      return runSafely('Memory get', key, async () => {
        const result = memory.get(key)
        if (!result) return { success: false, output: `Memory not found: "${key}"` }

        const created = new Date(result.createdAt).toISOString()
        const updated = new Date(result.updatedAt).toISOString()
        let output = `Memory [${key}] (${result.category}, ${result.source}):\n${result.value}\n\nCreated: ${created}\nUpdated: ${updated}`
        if (result.imagePath) output += `\n[Image: ${result.imagePath}]`

        return { success: true, output }
      })
    },
  }

  const memorySetTool: Tool = {
    definition: {
      name: 'memory_set',
      description:
        'Store a new memory or update an existing one. Use this to remember important facts, user preferences, decisions, or project context for future conversations.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'A unique identifier for this memory (e.g., "user_name", "project_goal")',
          },
          value: { type: 'string', description: 'The content to remember' },
          category: {
            type: 'string',
            description: `Category: ${VALID_CATEGORIES.join(', ')} (default: general)`,
          },
        },
        required: ['key', 'value'],
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const key = params.key as string
      const value = params.value as string
      const category = (params.category as MemoryCategory) ?? 'general'

      if (!isValidCategory(category)) {
        return {
          success: false,
          output: `Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(', ')}`,
        }
      }

      return runSafely('Memory set', key, async () => {
        await memory.set(key, value, { category, source: 'manual' })
        return { success: true, output: `Memory stored: "${key}" [${category}]` }
      })
    },
  }

  const memoryDeleteTool: Tool = {
    definition: {
      name: 'memory_delete',
      description:
        'Delete a memory by its exact key. Use this to remove outdated or incorrect information.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'The exact memory key to delete' } },
        required: ['key'],
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const key = params.key as string
      return runSafely('Memory delete', key, async () => {
        const deleted = memory.delete(key)
        if (!deleted) return { success: false, output: `Memory not found: "${key}"` }
        return { success: true, output: `Memory deleted: "${key}"` }
      })
    },
  }

  const memoryListTool: Tool = {
    definition: {
      name: 'memory_list',
      description:
        'List stored memories with their keys, categories, and previews. Supports filtering by category and source.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max memories to list (default: 20)' },
          offset: { type: 'number', description: 'Skip count for pagination (default: 0)' },
          category: {
            type: 'string',
            description: `Filter by category: ${VALID_CATEGORIES.join(', ')}`,
          },
          source: {
            type: 'string',
            description: 'Filter by source: manual, auto, conversation',
          },
        },
        required: [],
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const limit = (params.limit as number) ?? 20
      const offset = (params.offset as number) ?? 0
      const category = params.category as MemoryCategory | undefined
      const source = params.source as 'manual' | 'auto' | 'conversation' | undefined

      return runSafely('Memory list', '', async () => {
        const total = memory.count()
        const items = memory.list(limit, offset, { category, source })

        if (items.length === 0) {
          return {
            success: true,
            output:
              total === 0
                ? 'No memories stored yet.'
                : `No memories matching filters at offset ${offset} (${total} total).`,
          }
        }

        const lines = items.map((m, i) => {
          const preview = m.value.length > 100 ? `${m.value.slice(0, 100)}...` : m.value
          const date = new Date(m.updatedAt).toISOString().slice(0, 10)
          return `${offset + i + 1}. [${m.key}] (${m.category}, ${m.source}, ${date})\n   ${preview}`
        })

        const filterDesc = [category && `category=${category}`, source && `source=${source}`]
          .filter(Boolean)
          .join(', ')
        const header = `Memories ${offset + 1}-${offset + items.length} of ${total}${filterDesc ? ` (${filterDesc})` : ''}:`

        return { success: true, output: `${header}\n\n${lines.join('\n\n')}` }
      })
    },
  }

  const memoryRecallTool: Tool = {
    definition: {
      name: 'memory_recall',
      description:
        'Recall memories from a specific time period. Use this for temporal queries like "what did we discuss last week" or "what decisions were made this month".',
      parameters: {
        type: 'object',
        properties: {
          since: {
            type: 'string',
            description: 'Start of range (ISO date or "7 days ago", "last week", "this month")',
          },
          until: {
            type: 'string',
            description: 'End of range (ISO or relative). Defaults to now.',
          },
          query: {
            type: 'string',
            description: 'Optional search query to filter results within the time range',
          },
          category: {
            type: 'string',
            description: `Filter by category: ${VALID_CATEGORIES.join(', ')}`,
          },
          limit: { type: 'number', description: 'Max results (default: 20)' },
        },
        required: ['since'],
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const sinceStr = params.since as string
      const untilStr = params.until as string | undefined
      const query = params.query as string | undefined
      const category = params.category as string | undefined
      const limit = (params.limit as number) ?? 20

      return runSafely('Memory recall', '', async () => {
        const sinceTs = parseTimeExpression(sinceStr)
        const untilTs = untilStr ? parseTimeExpression(untilStr) : undefined

        if (!sinceTs) {
          return {
            success: false,
            output: `Could not parse time expression: "${sinceStr}". Try ISO date (2025-01-15) or relative (7 days ago, last week, this month).`,
          }
        }

        let results: SearchResult[]
        if (query) {
          const categories = isValidCategory(category) ? [category] : undefined
          results = await memory.searchFiltered(query, {
            limit,
            categories,
            since: sinceTs,
            until: untilTs,
          })
        } else {
          results = memory.getByTimeRange(sinceTs, untilTs, limit)
          if (isValidCategory(category)) {
            results = results.filter((r) => r.memory.category === category)
          }
        }

        const timeDesc = formatTimeRange(sinceTs, untilTs)
        if (results.length === 0) {
          return {
            success: true,
            output: `No memories found ${timeDesc}${category ? ` (category: ${category})` : ''}${query ? ` matching "${query}"` : ''}`,
          }
        }

        return {
          success: true,
          output: `Found ${results.length} memories ${timeDesc}:\n\n${formatTemporalResults(results)}`,
        }
      })
    },
  }

  return {
    memorySearchTool,
    memoryGetTool,
    memorySetTool,
    memoryDeleteTool,
    memoryListTool,
    memoryRecallTool,
  }
}

/** Parse relative and absolute time expressions into epoch milliseconds. */
function parseTimeExpression(expr: string): number | undefined {
  const trimmed = expr.trim().toLowerCase()

  const isoDate = new Date(expr)
  if (!Number.isNaN(isoDate.getTime())) return isoDate.getTime()

  const now = Date.now()
  const DAY = 86_400_000
  const WEEK = 7 * DAY

  if (trimmed === 'today') return now - DAY
  if (trimmed === 'yesterday') return now - 2 * DAY
  if (trimmed === 'last week' || trimmed === 'this week') return now - WEEK
  if (trimmed === 'last month' || trimmed === 'this month') return now - 30 * DAY

  const agoMatch = trimmed.match(/^(\d+)\s+(day|days|week|weeks|hour|hours|minute|minutes)\s+ago$/)
  if (agoMatch) {
    const count = parseInt(agoMatch[1] ?? '0', 10)
    const unit = agoMatch[2] ?? ''
    if (unit.startsWith('day')) return now - count * DAY
    if (unit.startsWith('week')) return now - count * WEEK
    if (unit.startsWith('hour')) return now - count * 3_600_000
    if (unit.startsWith('minute')) return now - count * 60_000
  }

  return undefined
}

function formatTimeRange(since: number, until?: number): string {
  const sinceDate = new Date(since).toISOString().slice(0, 10)
  if (until) {
    const untilDate = new Date(until).toISOString().slice(0, 10)
    return `from ${sinceDate} to ${untilDate}`
  }
  return `since ${sinceDate}`
}

function formatSearchResults(results: SearchResult[]): string {
  return results
    .map((r, i) => {
      const score = r.score.toFixed(3)
      const value = r.memory.value
      const preview = value.length > 200 ? `${value.slice(0, 200)}...` : value
      const imageNote = r.memory.imagePath ? ` [has image]` : ''
      const cat = r.memory.category !== 'general' ? ` ${r.memory.category}` : ''
      const date = new Date(r.memory.createdAt).toISOString().slice(0, 10)
      return `${i + 1}. [${r.memory.key}] (score: ${score},${cat} ${date})${imageNote}\n   ${preview}`
    })
    .join('\n\n')
}

function formatTemporalResults(results: SearchResult[]): string {
  return results
    .map((r, i) => {
      const value = r.memory.value
      const preview = value.length > 200 ? `${value.slice(0, 200)}...` : value
      const created = new Date(r.memory.createdAt).toISOString().slice(0, 16).replace('T', ' ')
      const cat = r.memory.category
      const source = r.memory.source
      return `${i + 1}. [${r.memory.key}] (${cat}, ${source}, ${created})\n   ${preview}`
    })
    .join('\n\n')
}
