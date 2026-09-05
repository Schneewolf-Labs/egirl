/**
 * A codex run that ends quickly must still reach the parent.
 *
 * The runner talks to the parent over piped stdout, where `console.log` is asynchronous. Exiting
 * the moment the child exits drops whatever is still queued, so a fast codex run arrived as a
 * clean exit with an empty transcript -- and the parent reports an empty transcript as "produced
 * no output ... check that working_dir points at the repository", naming the wrong cause and
 * discarding the real error.
 *
 * Reproduced against the real binary before the fix: codex rejected a flag, printed a usage error
 * to the pty, and the parent received zero bytes.
 *
 * These drive the runner with EGIRL_CODEX_BIN so the behaviour is exercised without a codex
 * install; the failure is in the runner's exit path, not in codex.
 */

import { describe, expect, test } from 'bun:test'
import { spawn } from 'child_process'
import { join } from 'path'
import { nodeBinary } from '../../src/tools/builtin/code-agent/node-binary'

const RUNNER = join(import.meta.dir, '../../src/tools/builtin/code-agent/codex-pty-runner.cjs')
const NODE = nodeBinary()
if (!NODE) throw new Error('The PTY integration tests require real Node.js')

type RunnerResult = { code: number | null; events: Array<Record<string, unknown>>; raw: string }

function runRunner(bin: string, args: string[], timeoutMs = 15000): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const encoded = Buffer.from(JSON.stringify(args)).toString('base64')
    const proc = spawn(NODE, [RUNNER, process.cwd(), encoded], {
      cwd: process.cwd(),
      env: { ...process.env, EGIRL_CODEX_BIN: bin, TERM: 'xterm-256color', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let raw = ''
    proc.stdout.on('data', (d) => {
      raw += d.toString()
    })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
    }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)
      const events = raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Record<string, unknown>]
          } catch {
            return []
          }
        })
      resolve({ code, events, raw })
    })
  })
}

describe('codex pty runner', () => {
  test('output from a fast-exiting child reaches the parent', async () => {
    const result = await runRunner(NODE, ['-e', 'console.log("transcript-line")'])

    const data = result.events.filter((e) => e.type === 'data')
    expect(data.length).toBeGreaterThan(0)
    expect(data.map((e) => String(e.data)).join('')).toContain('transcript-line')
  })

  test('the exit event is delivered, not dropped', async () => {
    const result = await runRunner(NODE, ['-e', 'console.log("done")'])

    const exit = result.events.find((e) => e.type === 'exit')
    expect(exit).toBeDefined()
    expect(exit?.exitCode).toBe(0)
  })

  test('a failing child still delivers its output and exit code', async () => {
    // The case that was silently swallowed: the child says why it failed, then exits immediately.
    const result = await runRunner(NODE, [
      '-e',
      'console.error("usage error: unknown flag"); process.exitCode = 2',
    ])

    const text = result.events
      .filter((e) => e.type === 'data')
      .map((e) => String(e.data))
      .join('')
    expect(text).toContain('usage error')

    const exit = result.events.find((e) => e.type === 'exit')
    expect(exit?.exitCode).toBe(2)
    expect(result.code).toBe(2)
  })

  test('the process still exits rather than hanging on the drain backstop', async () => {
    const started = Date.now()
    const result = await runRunner(NODE, ['-e', 'console.log("quick")'])
    // The unref'd 5s backstop must not become the exit path for a normal run.
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.code).toBe(0)
  })
})
