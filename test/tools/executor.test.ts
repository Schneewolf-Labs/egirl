import { describe, test, expect } from 'bun:test'
import { createDefaultToolExecutor } from '../../src/tools'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, mkdir, rm } from 'fs/promises'

describe('ToolExecutor', () => {
  const executor = createDefaultToolExecutor()
  const testDir = join(tmpdir(), 'egirl-test-' + Date.now())

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
      testDir
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
      testDir
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('test content')

    await rm(testDir, { recursive: true, force: true })
  })

  test('handles unknown tool gracefully', async () => {
    const result = await executor.execute(
      { id: 'call_1', name: 'nonexistent_tool', arguments: {} },
      testDir
    )

    expect(result.success).toBe(false)
    expect(result.output).toContain('Unknown tool')
  })

  test('executes command tool', async () => {
    await mkdir(testDir, { recursive: true })

    const result = await executor.execute(
      { id: 'call_1', name: 'execute_command', arguments: { command: 'echo "hello"' } },
      testDir
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('hello')

    await rm(testDir, { recursive: true, force: true })
  })
})
