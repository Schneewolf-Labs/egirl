import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { gitPrStateTool } from '../../src/tools/builtin/git-pr-state'

describe('git_pr_state', () => {
  const dir = join(tmpdir(), `egirl-pr-state-test-${Date.now()}`)
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf-8' })
  const commit = async (file: string, body: string, msg: string) => {
    await writeFile(join(dir, file), body)
    git(`add ${file}`)
    git(`commit -q -m "${msg}"`)
  }
  const run = (params: Record<string, unknown>) => gitPrStateTool.execute(params, dir)

  beforeAll(async () => {
    await mkdir(dir, { recursive: true })
    git('init -q -b main')
    git('config user.email test@test.com')
    git('config user.name Test')
    git('config commit.gpgsign false')
    await commit('a.txt', 'one\n', 'base')

    // conflicting: the PR and main both rewrite a.txt
    git('checkout -q -b conflict')
    await commit('a.txt', 'pr\n', 'pr edits a')
    // clean: touches only its own file
    git('checkout -q main')
    git('checkout -q -b clean')
    await commit('b.txt', 'new\n', 'pr adds b')
    // equivalent: the same patch is re-landed on main below
    git('checkout -q main')
    git('checkout -q -b equivalent')
    await commit('c.txt', 'same\n', 'pr adds c')

    git('checkout -q main')
    await commit('a.txt', 'main\n', 'main edits a')
    await commit('c.txt', 'same\n', 'main lands c')
    git('checkout -q -b merged')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('reports conflicts from a real trial merge, and main commits on shared files', async () => {
    const r = await run({ head: 'conflict' })
    expect(r.success).toBe(true)
    expect(r.output).toContain('main has 2 commit(s) since the merge base')
    expect(r.output).toContain('CONFLICTS in 1 file(s)')
    expect(r.output).toContain('main edits a')
    expect(git('status --porcelain')).toBe('')
    expect(git('worktree list').trim().split('\n')).toHaveLength(1)
  })

  test('clean merge shows what it would change and can keep the merged worktree', async () => {
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    const r = await run({ head: 'clean', worktree: true })
    expect(r.output).toContain('Trial merge into main: clean')
    expect(r.output).toContain('b.txt')
    const path = r.output.match(/kept at (\S+) /)?.[1] ?? ''
    expect(existsSync(join(path, 'b.txt'))).toBe(true)
    expect(existsSync(join(path, 'node_modules'))).toBe(true)
    expect(r.output).toContain('linked node_modules')
    git(`worktree remove --force ${path}`)
  })

  test('marks PR commits already on main as equivalent patches', async () => {
    const r = await run({ head: 'equivalent' })
    expect(r.output).toContain('pr adds c  [already on main as an equivalent patch]')
    expect(r.output).toContain('clean, and it changes nothing')
  })

  test('says when the branch is already merged', async () => {
    const r = await run({ head: 'merged' })
    expect(r.output).toContain('Already merged')
  })

  test('unknown ref fails', async () => {
    const r = await run({ head: 'nope' })
    expect(r.success).toBe(false)
  })
})
