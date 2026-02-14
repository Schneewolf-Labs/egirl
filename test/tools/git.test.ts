import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createDefaultToolExecutor } from '../../src/tools'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, mkdir, rm } from 'fs/promises'
import { execSync } from 'child_process'

describe('git tools', () => {
  const executor = createDefaultToolExecutor()
  const testDir = join(tmpdir(), 'egirl-git-test-' + Date.now())

  function exec(cmd: string): string {
    return execSync(cmd, { cwd: testDir, encoding: 'utf-8' })
  }

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true })
    exec('git init')
    exec('git config user.email "test@test.com"')
    exec('git config user.name "Test"')
    exec('git config commit.gpgsign false')
    await writeFile(join(testDir, 'hello.txt'), 'hello world\n')
    exec('git add . && git commit -m "Initial commit"')
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('has git tools registered', () => {
    const tools = executor.listTools()
    expect(tools).toContain('git_status')
    expect(tools).toContain('git_diff')
    expect(tools).toContain('git_log')
    expect(tools).toContain('git_commit')
    expect(tools).toContain('git_show')
  })

  test('git_status shows clean tree', async () => {
    const result = await executor.execute(
      { id: 'call_1', name: 'git_status', arguments: {} },
      testDir
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('clean working tree')
  })

  test('git_status shows modified files', async () => {
    await writeFile(join(testDir, 'hello.txt'), 'hello modified\n')

    const result = await executor.execute(
      { id: 'call_1', name: 'git_status', arguments: {} },
      testDir
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('modified')
    expect(result.output).toContain('hello.txt')

    // Restore
    exec('git checkout -- hello.txt')
  })

  test('git_status shows untracked files', async () => {
    await writeFile(join(testDir, 'new-file.txt'), 'new\n')

    const result = await executor.execute(
      { id: 'call_1', name: 'git_status', arguments: {} },
      testDir
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('untracked')
    expect(result.output).toContain('new-file.txt')

    // Cleanup
    exec('rm new-file.txt')
  })

  test('git_diff shows unstaged changes', async () => {
    await writeFile(join(testDir, 'hello.txt'), 'hello modified\n')

    const result = await executor.execute(
      { id: 'call_1', name: 'git_diff', arguments: {} },
      testDir
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('hello.txt')
    expect(result.output).toContain('modified')

    exec('git checkout -- hello.txt')
  })

  test('git_diff shows staged changes', async () => {
    await writeFile(join(testDir, 'hello.txt'), 'staged change\n')
    exec('git add hello.txt')

    const result = await executor.execute(
      { id: 'call_1', name: 'git_diff', arguments: { staged: true } },
      testDir
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('hello.txt')

    exec('git reset HEAD hello.txt')
    exec('git checkout -- hello.txt')
  })

  test('git_diff with no changes', async () => {
    const result = await executor.execute(
      { id: 'call_1', name: 'git_diff', arguments: {} },
      testDir
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('No differences')
  })

  test('git_log shows commits', async () => {
    const result = await executor.execute(
      { id: 'call_1', name: 'git_log', arguments: {} },
      testDir
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('Initial commit')
  })

  test('git_log oneline format', async () => {
    const result = await executor.execute(
      { id: 'call_1', name: 'git_log', arguments: { oneline: true } },
      testDir
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('Initial commit')
    // oneline format should not include date
    expect(result.output).not.toContain('Test')
  })

  test('git_commit stages and commits', async () => {
    await writeFile(join(testDir, 'commit-test.txt'), 'commit me\n')

    const result = await executor.execute(
      { id: 'call_1', name: 'git_commit', arguments: { message: 'Add commit-test file', files: ['commit-test.txt'] } },
      testDir
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('Add commit-test file')
  })

  test('git_commit rejects empty message', async () => {
    const result = await executor.execute(
      { id: 'call_1', name: 'git_commit', arguments: { message: '' } },
      testDir
    )
    expect(result.success).toBe(false)
    expect(result.output).toContain('empty')
  })

  test('git_commit with nothing staged', async () => {
    const result = await executor.execute(
      { id: 'call_1', name: 'git_commit', arguments: { message: 'Empty commit' } },
      testDir
    )
    expect(result.success).toBe(false)
    expect(result.output).toContain('Nothing staged')
  })

  test('git_show shows latest commit', async () => {
    const result = await executor.execute(
      { id: 'call_1', name: 'git_show', arguments: {} },
      testDir
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('Add commit-test file')
    expect(result.output).toContain('commit-test.txt')
  })

  test('git_show with specific ref', async () => {
    const result = await executor.execute(
      { id: 'call_1', name: 'git_show', arguments: { ref: 'HEAD~1' } },
      testDir
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('Initial commit')
  })

  test('git_status fails outside git repo', async () => {
    const noGitDir = join(tmpdir(), 'egirl-nogit-' + Date.now())
    await mkdir(noGitDir, { recursive: true })

    const result = await executor.execute(
      { id: 'call_1', name: 'git_status', arguments: {} },
      noGitDir
    )
    expect(result.success).toBe(false)
    expect(result.output).toContain('Not a git repository')

    await rm(noGitDir, { recursive: true, force: true })
  })
})
