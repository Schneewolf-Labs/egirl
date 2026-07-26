import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RuntimeConfig } from '../../src/config'
import { createDefaultToolExecutor } from '../../src/tools'

const toolsConfig = {
  tools: {
    files: true,
    exec: true,
    git: true,
    memory: true,
    browser: true,
    github: false,
    tasks: false,
    codeAgent: false,
    webResearch: true,
    screenshot: true,
  },
} as unknown as RuntimeConfig

describe('ToolExecutor', () => {
  const executor = createDefaultToolExecutor(toolsConfig)
  const testDir = join(tmpdir(), `egirl-test-${Date.now()}`)

  test('has builtin tools registered', () => {
    const tools = executor.listTools()
    expect(tools).toContain('read_file')
    expect(tools).toContain('write_file')
    expect(tools).toContain('edit_file')
    expect(tools).toContain('execute_command')
    expect(tools).toContain('glob_files')
  })

  test('executes write_file tool', async () => {
    await mkdir(testDir, { recursive: true })

    const result = await executor.execute(
      { id: 'call_1', name: 'write_file', arguments: { path: 'test.txt', content: 'hello world' } },
      testDir,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('Successfully wrote')

    await rm(testDir, { recursive: true, force: true })
  })

  test('executes read_file tool', async () => {
    await mkdir(testDir, { recursive: true })
    await writeFile(join(testDir, 'read-test.txt'), 'test content')

    const result = await executor.execute(
      { id: 'call_1', name: 'read_file', arguments: { path: 'read-test.txt' } },
      testDir,
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('test content')

    await rm(testDir, { recursive: true, force: true })
  })

  test('handles unknown tool gracefully', async () => {
    const result = await executor.execute(
      { id: 'call_1', name: 'nonexistent_tool', arguments: {} },
      testDir,
    )

    expect(result.success).toBe(false)
    expect(result.output).toContain('Unknown tool')
  })

  test('fuzzy-matches casing and separator variants', async () => {
    await mkdir(testDir, { recursive: true })
    await writeFile(join(testDir, 'fuzzy-test.txt'), 'fuzzy content')

    const result = await executor.execute(
      { id: 'call_1', name: 'Read_File', arguments: { path: 'fuzzy-test.txt' } },
      testDir,
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('fuzzy content')

    await rm(testDir, { recursive: true, force: true })
  })

  test('fuzzy-matches namespaced and typo tool names', async () => {
    await mkdir(testDir, { recursive: true })

    const namespaced = await executor.execute(
      { id: 'call_1', name: 'functions.execute_command', arguments: { command: 'echo "ns"' } },
      testDir,
    )
    expect(namespaced.success).toBe(true)
    expect(namespaced.output).toContain('ns')

    const typo = await executor.execute(
      { id: 'call_2', name: 'execute_comand', arguments: { command: 'echo "typo"' } },
      testDir,
    )
    expect(typo.success).toBe(true)
    expect(typo.output).toContain('typo')

    await rm(testDir, { recursive: true, force: true })
  })

  test('suggests close names instead of guessing between ambiguous matches', async () => {
    // wit_file is two edits from both write_file and edit_file
    const result = await executor.execute(
      { id: 'call_1', name: 'wit_file', arguments: { path: 'x.txt' } },
      testDir,
    )

    expect(result.success).toBe(false)
    expect(result.output).toContain('Unknown tool: wit_file')
    expect(result.output).toContain('Did you mean')
    expect(result.output).toContain('write_file')
    expect(result.output).toContain('edit_file')
  })

  test('executes command tool', async () => {
    await mkdir(testDir, { recursive: true })

    const result = await executor.execute(
      { id: 'call_1', name: 'execute_command', arguments: { command: 'echo "hello"' } },
      testDir,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('hello')

    await rm(testDir, { recursive: true, force: true })
  })
})
