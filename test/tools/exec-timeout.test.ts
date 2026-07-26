import { describe, expect, test } from 'bun:test'
import { execTool, HARD_DEADLINE_SLACK_MS, KILL_GRACE_MS } from '../../src/tools/builtin/exec'

/**
 * Bound the escalation cases against the real constants rather than a magic number, plus
 * generous slack. The assertion only has to separate "came back on the escalation path" from
 * "ran the command's full 30s", and a hard-coded ceiling close to the true value is how a
 * correct implementation starts failing on a loaded machine. Verified still discriminating:
 * the pre-fix exec.ts returns 30002ms against this 17000ms ceiling.
 */
const ESCALATION_CEILING = KILL_GRACE_MS + HARD_DEADLINE_SLACK_MS + 10_000

/**
 * These pin the hangs, not the happy path. Each case below used to leave the promise pending
 * forever, which meant the tool call never returned and the agent run holding the session
 * mutex never finished. A regression here looks like a test TIMEOUT, not a failed assertion.
 */
const CWD = '/tmp'

describe('execute_command timeout escalation', () => {
  test('a normal command still succeeds', async () => {
    const r = await execTool.execute({ command: 'echo hello' }, CWD)
    expect(r.success).toBe(true)
    expect(r.output).toContain('hello')
  })

  test('reports a nonzero exit as failure', async () => {
    const r = await execTool.execute({ command: 'exit 3' }, CWD)
    expect(r.success).toBe(false)
  })

  test('a sleeping command is killed at the timeout and reports partial output', async () => {
    const t0 = Date.now()
    const r = await execTool.execute({ command: 'echo before; sleep 30', timeout: 300 }, CWD)
    const elapsed = Date.now() - t0
    expect(r.success).toBe(false)
    expect(r.output).toContain('timed out')
    expect(r.output).toContain('before') // partial stdout survives
    expect(elapsed).toBeLessThan(ESCALATION_CEILING)
  }, 30000)

  test('a command that TRAPS SIGTERM is still killed (SIGKILL escalation)', async () => {
    // Without escalation this survives SIGTERM and runs for its full 30s; with it, the
    // SIGKILL lands after the grace period.
    const t0 = Date.now()
    const r = await execTool.execute(
      { command: "trap '' TERM; echo trapped; sleep 30", timeout: 300 },
      CWD,
    )
    const elapsed = Date.now() - t0
    expect(r.success).toBe(false)
    expect(r.output).toContain('timed out')
    // must come back on the escalation path, well before the command's own 30s
    expect(elapsed).toBeLessThan(ESCALATION_CEILING)
  }, 45000)

  test('a backgrounded child holding stdout does not hang the call', async () => {
    // The shell exits immediately but the grandchild keeps the pipe open, so `close` never
    // fires. Signalling the process GROUP reaches the grandchild; the hard deadline covers
    // the case where even that is not enough.
    const t0 = Date.now()
    const r = await execTool.execute(
      { command: 'sleep 30 & echo spawned; wait', timeout: 300 },
      CWD,
    )
    const elapsed = Date.now() - t0
    expect(r.success).toBe(false)
    expect(r.output).toContain('timed out')
    expect(elapsed).toBeLessThan(ESCALATION_CEILING)
  }, 45000)

  test('a failure to spawn resolves rather than hanging', async () => {
    const r = await execTool.execute(
      { command: 'true', working_dir: '/nonexistent-dir-for-test' },
      CWD,
    )
    expect(r.success).toBe(false)
  }, 15000)
})
