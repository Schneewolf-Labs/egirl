/**
 * process_wait: one tool call that waits for an exit, new output, a matching line, or a log
 * file to change -- instead of sleep/ps/tail loops that cost a turn each.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessWaitTool } from '../../src/tools/builtin/process-wait'
import { ProcessRegistry } from '../../src/tools/process-registry'

const isPosix = process.platform !== 'win32'
let registry: ProcessRegistry

afterEach(async () => {
  await registry?.shutdownAll(1000)
})

function tool() {
  registry = new ProcessRegistry()
  return createProcessWaitTool({ registry })
}

const cwd = tmpdir()

describe('process_wait on a process_start process', () => {
  test.skipIf(!isPosix)(
    'returns when it exits, with its exit code and the output since',
    async () => {
      const t = tool()
      const p = registry.start({ command: 'sleep 0.2; echo hi; echo oops >&2; exit 3', cwd })
      const r = await t.execute({ id: p.id }, cwd)
      expect(r.success).toBe(true)
      expect(r.output).toContain('exited (exit 3)')
      expect(r.output).toContain('hi')
      expect(r.output).toContain('[stderr] oops')
    },
  )

  test.skipIf(!isPosix)(
    'returns at the first new line matching `match`, while it keeps running',
    async () => {
      const t = tool()
      const p = registry.start({
        command: 'sleep 0.2; echo building; echo BUILD OK; sleep 30',
        cwd,
      })
      const started = Date.now()
      const r = await t.execute({ id: p.id, match: 'BUILD (OK|FAILED)' }, cwd)
      expect(r.output).toStartWith('matched: BUILD OK')
      expect(Date.now() - started).toBeLessThan(5000)
      expect(registry.list().find((x) => x.id === p.id)?.status).toBe('running')
    },
  )

  test.skipIf(!isPosix)('until output returns at the first new output', async () => {
    const t = tool()
    const p = registry.start({ command: 'sleep 0.3; echo tick; sleep 30', cwd })
    const r = await t.execute({ id: p.id, until: 'output' }, cwd)
    expect(r.output).toStartWith('new output')
    expect(r.output).toContain('tick')
  })
})

describe('process_wait on a bare pid', () => {
  test.skipIf(!isPosix)('returns when the process is gone', async () => {
    const t = tool()
    const child = Bun.spawn(['sleep', '0.4'])
    const r = await t.execute({ pid: child.pid }, cwd)
    expect(r.output).toStartWith(`pid ${child.pid} exited`)
  })

  test('refuses output waits and dead pids', async () => {
    const t = createProcessWaitTool({ registry: new ProcessRegistry(), isAlive: () => false })
    expect((await t.execute({ pid: 123, match: 'x' }, cwd)).output).toContain('watch its log')
    expect((await t.execute({ pid: 123 }, cwd)).output).toContain('No running process')
  })
})

describe('process_wait on a file', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'pwait-')), 'run.log')

  test('returns when the file grows, with only the new content', async () => {
    const t = tool()
    const path = file()
    writeFileSync(path, 'old line\n')
    setTimeout(() => appendFileSync(path, 'epoch 3 loss 0.41\n'), 300)
    const r = await t.execute({ file: path }, cwd)
    expect(r.output).toStartWith('file changed')
    expect(r.output).toContain('epoch 3 loss 0.41')
    expect(r.output).not.toContain('old line')
  })

  test('with match, waits past lines that do not match', async () => {
    const t = tool()
    const path = file()
    writeFileSync(path, '')
    setTimeout(() => appendFileSync(path, 'step 1\nstep 2\n'), 200)
    setTimeout(() => appendFileSync(path, 'DONE in 4s\n'), 600)
    const r = await t.execute({ file: path, match: '^DONE' }, cwd)
    expect(r.output).toStartWith('matched: DONE in 4s')
    expect(r.output).toContain('step 2')
  })
})

describe('process_wait limits', () => {
  test('gives up at the timeout and says so', async () => {
    let t = 0
    const w = createProcessWaitTool({
      registry: new ProcessRegistry(),
      isAlive: () => true,
      now: () => t,
      sleep: async (ms) => {
        t += ms
      },
    })
    const r = await w.execute({ pid: 42, timeout_seconds: 10 }, cwd)
    expect(r.output).toStartWith('timed out after 10s')
  })

  test('stops when the run is interrupted', async () => {
    const controller = new AbortController()
    const w = createProcessWaitTool({ registry: new ProcessRegistry(), isAlive: () => true })
    setTimeout(() => controller.abort(), 300)
    const r = await w.execute({ pid: 42 }, cwd, { signal: controller.signal })
    expect(r.output).toStartWith('interrupted')
  })

  test('needs exactly one target and a valid regex', async () => {
    const w = createProcessWaitTool({ registry: new ProcessRegistry() })
    expect((await w.execute({}, cwd)).success).toBe(false)
    expect((await w.execute({ id: 'a', pid: 1 }, cwd)).success).toBe(false)
    expect((await w.execute({ id: 'a', match: '(' }, cwd)).output).toContain('Invalid match')
    expect((await w.execute({ id: 'nope' }, cwd)).output).toContain('No process with id nope')
  })
})
