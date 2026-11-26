import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execTool } from '../../src/tools/builtin/exec'
import { timeoutHint } from '../../src/tools/builtin/exec-shell'

/**
 * Observed in Jaeger's traces: of 92 failed commands, about 14 were `pkill -f <pattern>` killing
 * its own shell, about 6 were bash syntax under dash, and 16 timeouts were `timeout N` around a
 * program that ignored SIGTERM.
 */

const CWD = tmpdir()
const scripts = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('egirl-cmd-'))

describe('execute_command shell', () => {
  test('pkill -f with a pattern from the command no longer kills the command', async () => {
    const r = await execTool.execute(
      { command: 'pkill -f "egirl-selfkill-marker-42" ; echo survived' },
      CWD,
    )
    expect(r.output).toContain('survived')
    expect(r.success).toBe(true)
  })

  test('bash syntax works', async () => {
    if (!existsSync('/bin/bash') && !existsSync('/usr/bin/bash')) return
    const r = await execTool.execute({ command: 'cat <<< hi && [[ 1 == 1 ]] && echo bash' }, CWD)
    expect(r.success).toBe(true)
    expect(r.output).toContain('hi')
    expect(r.output).toContain('bash')
  })

  test('a command that reads stdin gets EOF instead of waiting', async () => {
    const started = Date.now()
    const r = await execTool.execute({ command: 'cat; echo done', timeout: 10_000 }, CWD)
    expect(r.output).toContain('done')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test('exit codes, stderr and cwd behave as before', async () => {
    const r = await execTool.execute({ command: 'pwd; echo oops >&2; exit 4' }, CWD)
    expect(r.success).toBe(false)
    expect(r.output).toContain(CWD)
    expect(r.output).toContain('oops')
    expect(r.output).toContain('exit code 4')
  })

  test('the script is removed afterwards', async () => {
    const before = new Set(scripts())
    await execTool.execute({ command: 'echo x' }, CWD)
    expect(scripts().filter((n) => !before.has(n))).toEqual([])
  })
})

describe('timeoutHint', () => {
  test('a timeout(1) without a kill-after gets the hint', () => {
    expect(timeoutHint('cd port && timeout 18 env A=1 ./build/petz4 x')).toContain('timeout -k 5 N')
    expect(timeoutHint('timeout 5 ./app')).toBeDefined()
  })

  test('none when it already escalates, or there is no timeout(1)', () => {
    expect(timeoutHint('timeout -k 5 18 ./app')).toBeUndefined()
    expect(timeoutHint('timeout --kill-after=5 18 ./app')).toBeUndefined()
    expect(timeoutHint('timeout -s KILL 18 ./app')).toBeUndefined()
    expect(timeoutHint('sleep 100')).toBeUndefined()
    expect(timeoutHint('grep timeout_ms config.toml')).toBeUndefined()
  })
})
