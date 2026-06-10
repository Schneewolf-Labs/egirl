import { describe, expect, test } from 'bun:test'
import { matchToolName, normalizeToolName } from '../../src/tools/fuzzy-match'

const TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'glob_files',
  'execute_command',
  'git_status',
  'git_diff',
  'git_log',
  'memory_get',
  'memory_set',
  'memory_search',
  'web_research',
  'screenshot',
]

describe('normalizeToolName', () => {
  test('leaves snake_case names unchanged', () => {
    expect(normalizeToolName('read_file')).toBe('read_file')
  })

  test('lowercases and converts camelCase boundaries', () => {
    expect(normalizeToolName('readFile')).toBe('read_file')
    expect(normalizeToolName('ReadFile')).toBe('read_file')
    expect(normalizeToolName('READ_FILE')).toBe('read_file')
  })

  test('collapses separators and strips trailing junk', () => {
    expect(normalizeToolName('read-file')).toBe('read_file')
    expect(normalizeToolName('read.file')).toBe('read_file')
    expect(normalizeToolName('read_file()')).toBe('read_file')
    expect(normalizeToolName('_read_file_')).toBe('read_file')
  })
})

describe('matchToolName', () => {
  test('exact names match directly', () => {
    expect(matchToolName('read_file', TOOLS).match).toBe('read_file')
  })

  test('matches casing and separator variants', () => {
    expect(matchToolName('Read_File', TOOLS).match).toBe('read_file')
    expect(matchToolName('READ_FILE', TOOLS).match).toBe('read_file')
    expect(matchToolName('readFile', TOOLS).match).toBe('read_file')
    expect(matchToolName('read-file', TOOLS).match).toBe('read_file')
    expect(matchToolName('execute_command()', TOOLS).match).toBe('execute_command')
  })

  test('strips hallucinated namespaces', () => {
    expect(matchToolName('functions.read_file', TOOLS).match).toBe('read_file')
    expect(matchToolName('tools/git_status', TOOLS).match).toBe('git_status')
  })

  test('matches single-character typos', () => {
    expect(matchToolName('execute_comand', TOOLS).match).toBe('execute_command')
    expect(matchToolName('git_statu', TOOLS).match).toBe('git_status')
  })

  test('matches adjacent transpositions as one edit', () => {
    expect(matchToolName('execute_commnad', TOOLS).match).toBe('execute_command')
    expect(matchToolName('read_fiel', TOOLS).match).toBe('read_file')
  })

  test('does not auto-match across distinct tools two edits apart', () => {
    // web_search is not registered; web_research is 2 edits away and takes
    // different arguments, so it must be suggested rather than executed.
    const result = matchToolName('web_search', TOOLS)
    expect(result.match).toBeUndefined()
    expect(result.suggestions).toContain('web_research')
  })

  test('never guesses between tied candidates', () => {
    // memory_xet is one edit from both memory_get and memory_set
    const result = matchToolName('memory_xet', TOOLS)
    expect(result.match).toBeUndefined()
    expect(result.suggestions).toContain('memory_get')
    expect(result.suggestions).toContain('memory_set')
  })

  test('does not edit-distance match very short names', () => {
    const result = matchToolName('runs', ['run'])
    expect(result.match).toBeUndefined()
    expect(result.suggestions).toContain('run')
  })

  test('suggests close names when no confident match exists', () => {
    const result = matchToolName('exec_command', TOOLS)
    expect(result.match).toBeUndefined()
    expect(result.suggestions).toContain('execute_command')
    expect(result.suggestions.length).toBeLessThanOrEqual(3)
  })

  test('returns no suggestions for names unlike any tool', () => {
    const result = matchToolName('quantum_flux_capacitor', TOOLS)
    expect(result.match).toBeUndefined()
    expect(result.suggestions).toEqual([])
  })

  test('handles empty inputs', () => {
    expect(matchToolName('read_file', []).match).toBeUndefined()
    expect(matchToolName('', TOOLS).match).toBeUndefined()
  })
})
