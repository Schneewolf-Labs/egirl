import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execSync } from 'child_process'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { gatherStandup } from '../../src/standup'

describe('gatherStandup', () => {
  const testDir = join(tmpdir(), `egirl-standup-integration-${Date.now()}`)

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
    await writeFile(join(testDir, 'feature.ts'), 'export function hello() {}\n')
    exec('git add . && git commit -m "Add feature module"')
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('returns empty context for non-git directories', async () => {
    const noGitDir = join(tmpdir(), `egirl-nogit-standup-${Date.now()}`)
    await mkdir(noGitDir, { recursive: true })

    const report = await gatherStandup(noGitDir)
    expect(report.isGitRepo).toBe(false)
    expect(report.context).toBe('')

    await rm(noGitDir, { recursive: true, force: true })
  })

  test('produces standup for clean repo', async () => {
    const report = await gatherStandup(testDir)
    expect(report.isGitRepo).toBe(true)
    expect(report.context).toContain('Workspace Standup')
    expect(report.context).toContain('Branch')
    expect(report.context).toContain('master')
    expect(report.context).toContain('clean')
    expect(report.context).toContain('Recent commits')
    expect(report.context).toContain('Add feature module')
    expect(report.context).toContain('Initial commit')
  })

  test('shows modified files in standup', async () => {
    await writeFile(join(testDir, 'hello.txt'), 'modified\n')
    await writeFile(join(testDir, 'untracked.txt'), 'new\n')

    const report = await gatherStandup(testDir)
    expect(report.context).toContain('1 modified')
    expect(report.context).toContain('1 untracked')
    expect(report.context).toContain('hello.txt')
    expect(report.context).toContain('untracked.txt')

    exec('git checkout -- hello.txt')
    exec('rm untracked.txt')
  })

  test('shows stash count in standup', async () => {
    await writeFile(join(testDir, 'hello.txt'), 'stash me\n')
    exec('git stash')

    const report = await gatherStandup(testDir)
    expect(report.context).toContain('Stashes')
    expect(report.context).toContain('1')

    exec('git stash drop')
  })

  test('shows last commit time', async () => {
    const report = await gatherStandup(testDir)
    expect(report.context).toContain('Last commit')
    expect(report.context).toContain('ago')
  })
})
