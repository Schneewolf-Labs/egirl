import { describe, expect, test } from 'bun:test'
import { interpretCodexExit } from '../../src/tools/builtin/code-agent/codex'

/**
 * A clean exit with an empty transcript must not be reported as success.
 *
 * Codex can exit 0 in a tenth of a second having done nothing, most often because it was pointed
 * at a directory where the task makes no sense. The close handler previously returned
 * `success: true` regardless of whether anything had been produced, so the operator model read
 * "completed" and told the user work was underway.
 *
 * Observed live while having egirl fix a failing suite in a sandbox clone: the operator called
 * `code_agent` without `working_dir`, codex ran in the persona workspace, and returned
 * `success: true` with an empty transcript in 0.1s. Nothing had been touched, and nothing said so.
 *
 * A wrong answer that looks like a right one is the failure mode worth testing for.
 */
describe('codex empty output', () => {
  test('an empty transcript is a failure even on exit 0', () => {
    const r = interpretCodexExit(0, '', '/home/u/.egirl/personas/kira', '0.1')
    expect(r).toBeDefined()
    expect(r?.success).toBe(false)
  })

  test('the failure names the working directory, because that is usually the cause', () => {
    const r = interpretCodexExit(0, '   \n  ', '/tmp/wrong-repo', '0.1')
    expect(r?.output).toContain('/tmp/wrong-repo')
    expect(r?.output).toContain('working_dir')
  })

  test('real output is left alone for the caller to handle', () => {
    expect(
      interpretCodexExit(0, '• Completed edits to mathutil.py', '/tmp/repo', '20.4'),
    ).toBeUndefined()
  })

  test('whitespace-only transcripts count as empty', () => {
    expect(interpretCodexExit(0, '\n\t  \n', '/tmp/repo', '0.2')).toBeDefined()
  })
})
