import { describe, expect, test } from 'bun:test'
import {
  buildDeferredIndex,
  createToolSearchTool,
  formatToolIndex,
  getDeferredDefinitions,
} from '../../src/tools/deferred-loader'
import type { Tool, ToolDefinition, ToolResult } from '../../src/tools/types'

function makeTool(name: string, description: string): Tool {
  return {
    definition: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: `Input for ${name}` },
        },
        required: ['input'],
      },
    },
    async execute(): Promise<ToolResult> {
      return { success: true, output: `${name} executed` }
    },
  }
}

function makeToolMap(tools: Tool[]): Map<string, Tool> {
  const map = new Map<string, Tool>()
  for (const tool of tools) {
    map.set(tool.definition.name, tool)
  }
  return map
}

describe('buildDeferredIndex', () => {
  test('builds index from tool map', () => {
    const tools = makeToolMap([
      makeTool('read_file', 'Read a file from disk. Supports line ranges.'),
      makeTool('git_status', 'Show repository state including branch and changes.'),
      makeTool('web_research', 'Fetch a URL and return its text content.'),
    ])

    const index = buildDeferredIndex(tools)

    expect(index.entries.size).toBe(3)
    expect(index.entries.get('read_file')).toBeTruthy()
    expect(index.entries.get('git_status')).toBeTruthy()
    expect(index.allDefinitions.size).toBe(3)
  })

  test('always-loaded tools appear in alwaysLoaded list', () => {
    const tools = makeToolMap([
      makeTool('read_file', 'Read a file'),
      makeTool('execute_command', 'Run a shell command'),
      makeTool('git_status', 'Show git status'),
    ])

    const index = buildDeferredIndex(tools)

    const alwaysLoadedNames = index.alwaysLoaded.map((d) => d.name)
    expect(alwaysLoadedNames).toContain('read_file')
    expect(alwaysLoadedNames).toContain('execute_command')
    expect(alwaysLoadedNames).not.toContain('git_status')
  })

  test('extracts first sentence for compact description', () => {
    const tools = makeToolMap([
      makeTool('read_file', 'Read a file from disk. Supports line ranges and encoding.'),
    ])

    const index = buildDeferredIndex(tools)
    const desc = index.entries.get('read_file')!
    // Should be first sentence only
    expect(desc).toBe('Read a file from disk')
  })
})

describe('createToolSearchTool', () => {
  const tools = makeToolMap([
    makeTool('read_file', 'Read a file from disk.'),
    makeTool('write_file', 'Write content to a file.'),
    makeTool('git_status', 'Show repository state.'),
    makeTool('git_diff', 'Show differences between commits.'),
    makeTool('web_research', 'Fetch a URL and return text.'),
    makeTool('memory_search', 'Search stored memories.'),
  ])
  const index = buildDeferredIndex(tools)
  const searchTool = createToolSearchTool(index)

  test('has correct definition', () => {
    expect(searchTool.definition.name).toBe('tool_search')
    expect(searchTool.definition.description).toContain('Search for tools')
  })

  test('finds tool by exact name', async () => {
    const result = await searchTool.execute({ query: 'git_status' }, '')
    expect(result.success).toBe(true)
    const schemas = JSON.parse(result.output)
    expect(schemas).toHaveLength(1)
    expect(schemas[0].name).toBe('git_status')
    expect(schemas[0].parameters).toBeTruthy()
  })

  test('finds tools by keyword', async () => {
    const result = await searchTool.execute({ query: 'git' }, '')
    expect(result.success).toBe(true)
    const schemas = JSON.parse(result.output)
    expect(schemas.length).toBeGreaterThanOrEqual(2)
    expect(schemas.map((s: ToolDefinition) => s.name)).toContain('git_status')
    expect(schemas.map((s: ToolDefinition) => s.name)).toContain('git_diff')
  })

  test('respects max_results', async () => {
    const result = await searchTool.execute({ query: 'git', max_results: 1 }, '')
    expect(result.success).toBe(true)
    const schemas = JSON.parse(result.output)
    expect(schemas).toHaveLength(1)
  })

  test('returns helpful message for no matches', async () => {
    const result = await searchTool.execute({ query: 'nonexistent_tool' }, '')
    expect(result.success).toBe(true)
    expect(result.output).toContain('No tools found')
    expect(result.output).toContain('Available tools')
  })

  test('searches in description text', async () => {
    const result = await searchTool.execute({ query: 'url' }, '')
    expect(result.success).toBe(true)
    const schemas = JSON.parse(result.output)
    expect(schemas.map((s: ToolDefinition) => s.name)).toContain('web_research')
  })
})

describe('formatToolIndex', () => {
  test('formats compact index', () => {
    const tools = makeToolMap([
      makeTool('read_file', 'Read a file from disk.'),
      makeTool('git_status', 'Show repository state.'),
    ])
    const index = buildDeferredIndex(tools)
    const text = formatToolIndex(index)

    expect(text).toContain('tool_search')
    expect(text).toContain('read_file')
    expect(text).toContain('git_status')
    expect(text).toContain('[loaded]')
  })

  test('marks always-loaded tools', () => {
    const tools = makeToolMap([
      makeTool('read_file', 'Read a file.'),
      makeTool('execute_command', 'Run a command.'),
      makeTool('web_research', 'Fetch a URL.'),
    ])
    const index = buildDeferredIndex(tools)
    const text = formatToolIndex(index)

    // read_file and execute_command should be marked [loaded]
    const lines = text.split('\n')
    const readLine = lines.find((l) => l.includes('read_file'))
    const execLine = lines.find((l) => l.includes('execute_command'))
    const webLine = lines.find((l) => l.includes('web_research'))

    expect(readLine).toContain('[loaded]')
    expect(execLine).toContain('[loaded]')
    expect(webLine).not.toContain('[loaded]')
  })
})

describe('getDeferredDefinitions', () => {
  test('returns only always-loaded when no tools searched', () => {
    const tools = makeToolMap([
      makeTool('read_file', 'Read a file.'),
      makeTool('execute_command', 'Run a command.'),
      makeTool('git_status', 'Show status.'),
    ])
    const index = buildDeferredIndex(tools)

    const defs = getDeferredDefinitions(index, new Set())
    const names = defs.map((d) => d.name)

    expect(names).toContain('read_file')
    expect(names).toContain('execute_command')
    expect(names).not.toContain('git_status')
  })

  test('includes searched tools', () => {
    const tools = makeToolMap([
      makeTool('read_file', 'Read a file.'),
      makeTool('git_status', 'Show status.'),
      makeTool('git_diff', 'Show diffs.'),
    ])
    const index = buildDeferredIndex(tools)

    const loadedTools = new Set(['git_status', 'git_diff'])
    const defs = getDeferredDefinitions(index, loadedTools)
    const names = defs.map((d) => d.name)

    expect(names).toContain('read_file')
    expect(names).toContain('git_status')
    expect(names).toContain('git_diff')
  })

  test('does not duplicate always-loaded tools', () => {
    const tools = makeToolMap([
      makeTool('read_file', 'Read a file.'),
      makeTool('git_status', 'Show status.'),
    ])
    const index = buildDeferredIndex(tools)

    // read_file is always loaded — searching for it shouldn't duplicate
    const loadedTools = new Set(['read_file', 'git_status'])
    const defs = getDeferredDefinitions(index, loadedTools)
    const readCount = defs.filter((d) => d.name === 'read_file').length

    expect(readCount).toBe(1)
  })
})
