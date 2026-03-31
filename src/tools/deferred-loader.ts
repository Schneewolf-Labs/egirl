// Deferred tool loading: reduces system prompt size by only loading full
// tool schemas on demand via a tool_search meta-tool.
//
// Instead of sending all ~48 tool schemas in the system prompt (~3K tokens),
// sends a compact index (name + one-line description) and a tool_search tool.
// The model calls tool_search to get full schemas for tools it needs.

import type { ToolDefinition } from '../providers/types'
import type { Tool, ToolResult } from './types'

/** Tools that are always fully loaded (essential, small schemas) */
const ALWAYS_LOADED = new Set([
  'execute_command',
  'read_file',
  'write_file',
  'edit_file',
  'tool_search',
])

export interface DeferredToolIndex {
  /** Compact index entry: name -> one-line description */
  entries: Map<string, string>
  /** Full definitions for always-loaded tools */
  alwaysLoaded: ToolDefinition[]
  /** Full definitions for all tools (used when searching) */
  allDefinitions: Map<string, ToolDefinition>
}

/**
 * Build a deferred tool index from registered tools.
 * Returns the compact index + the always-loaded tool definitions.
 */
export function buildDeferredIndex(tools: Map<string, Tool>): DeferredToolIndex {
  const entries = new Map<string, string>()
  const alwaysLoaded: ToolDefinition[] = []
  const allDefinitions = new Map<string, ToolDefinition>()

  for (const [name, tool] of tools) {
    const def = tool.definition
    allDefinitions.set(name, def)

    // Extract first sentence of description as compact summary
    const firstSentence = def.description.split(/\.\s/)[0] ?? def.description
    entries.set(name, firstSentence.slice(0, 100))

    if (ALWAYS_LOADED.has(name)) {
      alwaysLoaded.push(def)
    }
  }

  return { entries, alwaysLoaded, allDefinitions }
}

/**
 * Create the tool_search meta-tool that returns full schemas on demand.
 */
export function createToolSearchTool(index: DeferredToolIndex): Tool {
  return {
    definition: {
      name: 'tool_search',
      description:
        'Search for tools by name or keyword and get their full schemas. Use this when you need to use a tool that is listed in the index but not yet loaded.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Tool name or keyword to search for. Can be an exact tool name or a search term.',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of tool schemas to return (default 5)',
          },
        },
        required: ['query'],
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const query = (params.query as string)?.toLowerCase() ?? ''
      const maxResults = (params.max_results as number) ?? 5

      // Find matching tools
      const matches: ToolDefinition[] = []

      for (const [name, description] of index.entries) {
        if (matches.length >= maxResults) break

        // Exact name match
        if (name === query) {
          const def = index.allDefinitions.get(name)
          if (def) matches.push(def)
          continue
        }

        // Keyword search in name and description
        if (name.includes(query) || description.toLowerCase().includes(query)) {
          const def = index.allDefinitions.get(name)
          if (def) matches.push(def)
        }
      }

      if (matches.length === 0) {
        return {
          success: true,
          output: `No tools found matching "${query}". Available tools:\n${[...index.entries.keys()].join(', ')}`,
        }
      }

      // Return full schemas
      const schemas = matches.map((def) => ({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      }))

      return {
        success: true,
        output: JSON.stringify(schemas, null, 2),
      }
    },
  }
}

/**
 * Build the compact tool index text for injection into the system prompt.
 * Much smaller than full schemas — just name + description per tool.
 */
export function formatToolIndex(index: DeferredToolIndex): string {
  const lines = ['Available tools (use tool_search to get full schemas):\n']
  for (const [name, description] of index.entries) {
    const loaded = ALWAYS_LOADED.has(name) ? ' [loaded]' : ''
    lines.push(`- ${name}: ${description}${loaded}`)
  }
  return lines.join('\n')
}

/**
 * Get tool definitions for the current turn.
 * In deferred mode, returns only always-loaded tools + any previously searched tools.
 * The agent loop should track which tools have been loaded via tool_search.
 */
export function getDeferredDefinitions(
  index: DeferredToolIndex,
  loadedToolNames: Set<string>,
): ToolDefinition[] {
  const defs = [...index.alwaysLoaded]

  for (const name of loadedToolNames) {
    if (ALWAYS_LOADED.has(name)) continue // Already included
    const def = index.allDefinitions.get(name)
    if (def) defs.push(def)
  }

  return defs
}
