import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, mkdir, rm } from 'fs/promises'
import { execSync } from 'child_process'
import {
  gatherBranch,
  gatherStatus,
  gatherRecentCommits,
  gatherStashCount,
  gatherLastCommitAge,
  isGitRepo,
} from '../../src/standup/gather'

describe('standup gather', () => {
  const testDir = join(tmpdir(), 'egirl-standup-test-' + Date.now())

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
    await writeFile(join(testDir, 'second.txt'), 'second\n')
    exec('git add . && git commit -m "Add second file"')
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('isGitRepo returns true for git repos', async () => {
    expect(await isGitRepo(testDir)).toBe(true)
  })

  test('isGitRepo returns false for non-git dirs', async () => {
    const noGitDir = join(tmpdir(), 'egirl-nogit-' + Date.now())
    await mkdir(noGitDir, { recursive: true })
    expect(await isGitRepo(noGitDir)).toBe(false)
    await rm(noGitDir, { recursive: true, force: true })
  })

  test('gatherBranch returns current branch', async () => {
    const branch = await gatherBranch(testDir)
    expect(branch).toBeDefined()
    expect(branch!.current).toBe('master')
    expect(branch!.tracking).toBeUndefined()
  })

  test('gatherStatus shows clean tree', async () => {
    const status = await gatherStatus(testDir)
    expect(status).toBeDefined()
    expect(status!.staged).toHaveLength(0)
    expect(status!.modified).toHaveLength(0)
    expect(status!.untracked).toHaveLength(0)
  })

  test('gatherStatus detects modified files', async () => {
    await writeFile(join(testDir, 'hello.txt'), 'modified\n')

    const status = await gatherStatus(testDir)
    expect(status).toBeDefined()
    expect(status!.modified).toContain('hello.txt')

    exec('git checkout -- hello.txt')
  })

  test('gatherStatus detects untracked files', async () => {
    await writeFile(join(testDir, 'new-file.txt'), 'new\n')

    const status = await gatherStatus(testDir)
    expect(status).toBeDefined()
    expect(status!.untracked).toContain('new-file.txt')

    exec('rm new-file.txt')
  })

  test('gatherStatus detects staged files', async () => {
    await writeFile(join(testDir, 'hello.txt'), 'staged\n')
    exec('git add hello.txt')

    const status = await gatherStatus(testDir)
    expect(status).toBeDefined()
    expect(status!.staged).toContain('hello.txt')

    exec('git reset HEAD hello.txt')
    exec('git checkout -- hello.txt')
  })

  test('gatherRecentCommits returns commits', async () => {
    const commits = await gatherRecentCommits(testDir)
    expect(commits.length).toBeGreaterThanOrEqual(2)
    expect(commits[0]!.message).toBe('Add second file')
    expect(commits[1]!.message).toBe('Initial commit')
    expect(commits[0]!.hash).toBeTruthy()
    expect(commits[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('gatherRecentCommits respects count', async () => {
    const commits = await gatherRecentCommits(testDir, 1)
    expect(commits).toHaveLength(1)
    expect(commits[0]!.message).toBe('Add second file')
  })

  test('gatherStashCount returns 0 with no stashes', async () => {
    const count = await gatherStashCount(testDir)
    expect(count).toBe(0)
  })

  test('gatherStashCount counts stashes', async () => {
    await writeFile(join(testDir, 'hello.txt'), 'stash me\n')
    exec('git stash')

    const count = await gatherStashCount(testDir)
    expect(count).toBe(1)

    exec('git stash drop')
  })

  test('gatherLastCommitAge returns a relative time', async () => {
    const age = await gatherLastCommitAge(testDir)
    expect(age).toBeDefined()
    // Should contain something like "X seconds ago"
    expect(age).toContain('ago')
  })
})
