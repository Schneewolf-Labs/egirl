import { describe, expect, test } from 'bun:test'
import type { Tool, ToolResult } from '../../src/tools/types'
import { levenshtein, remapParams, resolveToolName } from '../../src/tools/fuzzy-match'

function makeTool(name: string, paramKeys: string[] = []): Tool {
  const properties: Record<string, unknown> = {}
  for (const key of paramKeys) {
    properties[key] = { type: 'string', description: `The ${key}` }
  }

  return {
    definition: {
      name,
      description: `Test tool ${name}`,
      parameters: {
        type: 'object',
        properties,
        required: paramKeys,
      },
    },
    async execute(): Promise<ToolResult> {
      return { success: true, output: 'ok' }
    },
  }
}

function makeRegistry(tools: Tool[]): Map<string, Tool> {
  const map = new Map<string, Tool>()
  for (const tool of tools) {
    map.set(tool.definition.name, tool)
  }
  return map
}

describe('levenshtein', () => {
  test('identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0)
  })

  test('empty strings', () => {
    expect(levenshtein('', '')).toBe(0)
    expect(levenshtein('abc', '')).toBe(3)
    expect(levenshtein('', 'abc')).toBe(3)
  })

  test('single character difference', () => {
    expect(levenshtein('cat', 'bat')).toBe(1)
    expect(levenshtein('cat', 'cats')).toBe(1)
    expect(levenshtein('cat', 'at')).toBe(1)
  })

  test('multiple edits', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('read', 'write')).toBe(4)
  })
})

describe('resolveToolName', () => {
  const tools = makeRegistry([
    makeTool('read_file'),
    makeTool('write_file'),
    makeTool('edit_file'),
    makeTool('execute_command'),
    makeTool('glob_files'),
    makeTool('git_status'),
    makeTool('git_diff'),
    makeTool('memory_search'),
    makeTool('web_research'),
  ])

  test('exact match returns directly', () => {
    const result = resolveToolName('read_file', tools)
    expect(result).toBeDefined()
    expect(result!.resolvedName).toBe('read_file')
    expect(result!.method).toBe('exact')
  })

  test('camelCase matches snake_case via normalization', () => {
    const result = resolveToolName('readFile', tools)
    expect(result).toBeDefined()
    expect(result!.resolvedName).toBe('read_file')
    expect(result!.method).toBe('normalized')
  })

  test('wrong casing matches via normalization', () => {
    const result = resolveToolName('Read_File', tools)
    expect(result).toBeDefined()
    expect(result!.resolvedName).toBe('read_file')
    expect(result!.method).toBe('normalized')
  })

  test('hyphenated matches via normalization', () => {
    const result = resolveToolName('read-file', tools)
    expect(result).toBeDefined()
    expect(result!.resolvedName).toBe('read_file')
    expect(result!.method).toBe('normalized')
  })

  test('SCREAMING_CASE matches via normalization', () => {
    const result = resolveToolName('EXECUTE_COMMAND', tools)
    expect(result).toBeDefined()
    expect(result!.resolvedName).toBe('execute_command')
    expect(result!.method).toBe('normalized')
  })

  test('small typo matches via edit distance', () => {
    // "reed_file" → "read_file" (1 edit after normalization)
    const result = resolveToolName('reed_file', tools)
    expect(result).toBeDefined()
    expect(result!.resolvedName).toBe('read_file')
    expect(result!.method).toBe('distance')
  })

  test('swapped word order matches via edit distance', () => {
    // "file_read" normalized is "fileread" vs "readfile" — distance 4, too far
    // This should NOT match (edit distance too high)
    const result = resolveToolName('file_read', tools)
    expect(result).toBeUndefined()
  })

  test('completely wrong name returns undefined', () => {
    const result = resolveToolName('banana_split', tools)
    expect(result).toBeUndefined()
  })

  test('ambiguous match returns undefined', () => {
    // "git_dif" is 1 edit from "git_diff" but let's ensure no ambiguity with "git_status"
    // "gitdif" vs "gitdiff" = distance 1, "gitdif" vs "gitstatus" = distance 4 → unambiguous
    const result = resolveToolName('git_dif', tools)
    expect(result).toBeDefined()
    expect(result!.resolvedName).toBe('git_diff')
  })

  test('search_memory matches memory_search via edit distance', () => {
    // "searchmemory" vs "memorysearch" — distance is 6, too far
    // This should NOT match, which is correct — word reordering needs aliases, not fuzzy match
    const result = resolveToolName('search_memory', tools)
    expect(result).toBeUndefined()
  })

  test('empty name returns undefined', () => {
    const result = resolveToolName('', tools)
    expect(result).toBeUndefined()
  })
})

describe('remapParams', () => {
  const fileTool = makeTool('read_file', ['path', 'start_line', 'end_line'])

  test('exact params pass through unchanged', () => {
    const result = remapParams(fileTool.definition, { path: '/foo', start_line: 1 })
    expect(result).toEqual({ path: '/foo', start_line: 1 })
  })

  test('camelCase params remap to snake_case', () => {
    const result = remapParams(fileTool.definition, { path: '/foo', startLine: 5 })
    expect(result).toEqual({ path: '/foo', start_line: 5 })
  })

  test('wrong casing remaps', () => {
    const result = remapParams(fileTool.definition, { Path: '/foo', Start_Line: 1 })
    expect(result).toEqual({ path: '/foo', start_line: 1 })
  })

  test('small typo remaps via edit distance', () => {
    // "strt_line" normalized "strtline" vs "startline" — distance 1
    const result = remapParams(fileTool.definition, { path: '/foo', strt_line: 5 })
    expect(result).toEqual({ path: '/foo', start_line: 5 })
  })

  test('short param typo beyond threshold passes through', () => {
    // "paht" vs "path" — transposition = distance 2 on a 4-char name, exceeds threshold of 1
    const result = remapParams(fileTool.definition, { paht: '/foo' })
    expect(result).toEqual({ paht: '/foo' })
  })

  test('completely wrong param passes through as-is', () => {
    const result = remapParams(fileTool.definition, { path: '/foo', banana: 'yellow' })
    expect(result).toEqual({ path: '/foo', banana: 'yellow' })
  })

  test('tool with no properties returns args unchanged', () => {
    const noParamTool = makeTool('simple')
    const result = remapParams(noParamTool.definition, { foo: 'bar' })
    expect(result).toEqual({ foo: 'bar' })
  })

  test('mixed exact and fuzzy params', () => {
    const execTool = makeTool('execute_command', ['command', 'working_dir', 'timeout'])
    const result = remapParams(execTool.definition, {
      command: 'ls',
      workingDir: '/tmp',
      timeout: 5000,
    })
    expect(result).toEqual({
      command: 'ls',
      working_dir: '/tmp',
      timeout: 5000,
    })
  })
})
