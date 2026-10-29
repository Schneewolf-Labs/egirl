import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureGitBaseline, gitEvidence } from '../../src/tools/builtin/code-agent/evidence'

/**
 * The operator took code_agent's final message on trust: "done, tests pass" read the same whether
 * or not anything was written. The result now carries what git saw change during the run. It has
 * to count work the agent committed, since a tree left clean by a commit looks like "nothing
 * happened" to a plain `git status`.
 */

function git(dir: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'egirl-evidence-'))
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', 'a.txt')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

async function evidenceAfter(dir: string, run: () => void): Promise<string> {
  const baseline = await captureGitBaseline(dir)
  run()
  return gitEvidence(dir, baseline)
}

describe('code_agent disk evidence', () => {
  test('outside a git repo it says the changes were not checked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egirl-evidence-plain-'))
    expect(await captureGitBaseline(dir)).toBeUndefined()
    expect(await gitEvidence(dir, undefined)).toContain('not a git work tree')
  })

  test('a run that wrote nothing says so', async () => {
    const dir = gitRepo()
    const out = await evidenceAfter(dir, () => {})
    expect(out).toContain('nothing changed since the run started')
  })

  test('work the agent committed is reported even though the tree is clean', async () => {
    const dir = gitRepo()
    const out = await evidenceAfter(dir, () => {
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
      git(dir, 'commit', '-q', '-am', 'Add second line')
    })
    expect(out).toContain('Add second line')
    expect(out).toMatch(/a\.txt\s+\|\s+1 \+/)
    expect(out).not.toContain('nothing changed')
  })

  test('uncommitted edits and new files are reported', async () => {
    const dir = gitRepo()
    const out = await evidenceAfter(dir, () => {
      writeFileSync(join(dir, 'a.txt'), 'changed\n')
      writeFileSync(join(dir, 'new.ts'), 'export {}\n')
    })
    expect(out).toContain('a.txt')
    expect(out).toContain('?? new.ts')
  })

  test('a tree already dirty before the run is not mistaken for new work', async () => {
    const dir = gitRepo()
    writeFileSync(join(dir, 'a.txt'), 'left over\n')
    writeFileSync(join(dir, 'old.txt'), 'untracked before\n')
    expect(await evidenceAfter(dir, () => {})).toContain('nothing changed')

    const out = await evidenceAfter(dir, () => {
      writeFileSync(join(dir, 'a.txt'), 'left over\nand edited by the agent\n')
    })
    expect(out).not.toContain('nothing changed')
    expect(out).toContain('already had uncommitted changes')
    expect(out).not.toContain('old.txt')
  })

  test('a repo with no commits yet still reports what appeared', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egirl-evidence-unborn-'))
    git(dir, 'init', '-q')
    const out = await evidenceAfter(dir, () => writeFileSync(join(dir, 'first.txt'), 'x\n'))
    expect(out).toContain('first.txt')
  })
})
