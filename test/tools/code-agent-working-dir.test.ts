import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { inferWorkingDir, resolveWorkingDir } from '../../src/tools/builtin/code-agent/working-dir'

/**
 * The model routinely omits `working_dir` even when the task names a repository, and the tool then
 * silently runs in the persona workspace.
 *
 * Observed: "the test suite test/tools/missing-dependency.test.ts is failing in
 * /home/nbeerbower/Projects/dummy/egirl, fix it" produced a code_agent call with no working_dir.
 * Codex ran in ~/.egirl/personas/kira, exited in 0.1s, and the agent reported the work was
 * underway. Nothing had been touched.
 *
 * Inference is deliberately narrow: exactly one existing directory in the task text, or nothing.
 * Two candidates means the intent is ambiguous, and editing the wrong repository is worse than
 * running in the default and failing loudly.
 */

const root = mkdtempSync(join(tmpdir(), 'egirl-wd-'))
const repoA = join(root, 'repo-a')
const repoB = join(root, 'repo-b')
mkdirSync(repoA)
mkdirSync(repoB)

describe('inferWorkingDir', () => {
  test('finds a single existing directory named in the task', () => {
    expect(inferWorkingDir(`the tests fail in ${repoA}, fix them`, root)).toBe(repoA)
  })

  test('strips trailing sentence punctuation', () => {
    expect(inferWorkingDir(`look at ${repoA}.`, root)).toBe(repoA)
    expect(inferWorkingDir(`check (${repoB}), please`, root)).toBe(repoB)
  })

  test('refuses to guess when two directories are named', () => {
    expect(inferWorkingDir(`compare ${repoA} with ${repoB}`, root)).toBeUndefined()
  })

  test('ignores paths that do not exist', () => {
    expect(inferWorkingDir('fix /nonexistent/repo/somewhere please', root)).toBeUndefined()
  })

  test('ignores file paths — only directories are working dirs', () => {
    expect(
      inferWorkingDir('the file test/tools/missing-dependency.test.ts is failing', root),
    ).toBeUndefined()
  })
})

describe('resolveWorkingDir', () => {
  test('an explicit working_dir always wins', () => {
    const r = resolveWorkingDir({
      explicit: repoB,
      task: `something about ${repoA}`,
      configured: '/configured',
      cwd: '/cwd',
      home: root,
    })
    expect(r).toEqual({ dir: repoB, inferred: false })
  })

  test('falls back to the configured workspace when the task names nothing', () => {
    const r = resolveWorkingDir({
      task: 'tidy up the code',
      configured: '/configured',
      cwd: '/cwd',
      home: root,
    })
    expect(r).toEqual({ dir: '/configured', inferred: false })
  })

  test('infers, and says so, when the task names one repo and nothing was passed', () => {
    const r = resolveWorkingDir({
      task: `the suite in ${repoA} is failing`,
      configured: '/persona-workspace',
      cwd: '/cwd',
      home: root,
    })
    expect(r).toEqual({ dir: repoA, inferred: true })
  })
})
