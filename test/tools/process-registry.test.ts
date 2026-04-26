import { afterAll, describe, expect, test } from 'bun:test'
import { tmpdir } from 'os'
import { ProcessRegistry } from '../../src/tools/process-registry'

const registries: ProcessRegistry[] = []
function makeRegistry(): ProcessRegistry {
  const r = new ProcessRegistry()
  registries.push(r)
  return r
}

afterAll(async () => {
  for (const r of registries) await r.shutdownAll(1000)
})

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25))
  }
  if (!predicate()) throw new Error(`Timed out after ${timeoutMs}ms`)
}

describe('ProcessRegistry', () => {
  test('starts a process and captures stdout', async () => {
    const reg = makeRegistry()
    const snap = reg.start({ command: 'echo hello-world', cwd: tmpdir() })
    expect(snap.id).toMatch(/^proc_/)
    expect(snap.status).toBe('running')

    await waitFor(() => reg.list()[0]?.status === 'exited')

    const out = reg.output(snap.id)
    expect(out).toBeDefined()
    expect(out?.status).toBe('exited')
    expect(out?.stdout.join('\n')).toContain('hello-world')
  })

  test('list returns running and exited processes', async () => {
    const reg = makeRegistry()
    const a = reg.start({ command: 'echo a', cwd: tmpdir() })
    const b = reg.start({ command: 'echo b', cwd: tmpdir() })
    const ids = reg.list().map((p) => p.id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
    await waitFor(() => reg.list().every((p) => p.status !== 'running'))
  })

  test('output supports since_line for incremental reads', async () => {
    const reg = makeRegistry()
    const snap = reg.start({
      command: "printf 'one\\ntwo\\nthree\\n'",
      cwd: tmpdir(),
    })
    await waitFor(() => reg.list().find((p) => p.id === snap.id)?.status === 'exited')

    const first = reg.output(snap.id, { tailLines: 2 })
    expect(first?.stdout.length).toBe(2)
    expect(first?.stdoutNextLine).toBe(3)

    const after = reg.output(snap.id, { sinceLine: first?.stdoutNextLine })
    expect(after?.stdout.length).toBe(0)
  })

  test('stop kills a long-running process', async () => {
    const reg = makeRegistry()
    const snap = reg.start({ command: 'sleep 30', cwd: tmpdir() })
    expect(snap.status).toBe('running')

    const result = await reg.stop(snap.id, { timeoutMs: 1000 })
    expect(result.stopped).toBe(true)
    expect(['killed', 'exited']).toContain(result.status)
  })

  test('sendInput writes to stdin and process consumes it', async () => {
    const reg = makeRegistry()
    const snap = reg.start({ command: 'cat', cwd: tmpdir() })
    const ok = reg.sendInput(snap.id, 'ping')
    expect(ok).toBe(true)

    await waitFor(() => {
      const out = reg.output(snap.id)
      return (out?.stdout.join('\n') ?? '').includes('ping')
    })

    await reg.stop(snap.id, { timeoutMs: 1000 })
  })

  test('output returns undefined for unknown id', () => {
    const reg = makeRegistry()
    expect(reg.output('proc_missing')).toBeUndefined()
  })

  test('sendInput fails for stopped process', async () => {
    const reg = makeRegistry()
    const snap = reg.start({ command: 'echo done', cwd: tmpdir() })
    await waitFor(() => reg.list().find((p) => p.id === snap.id)?.status === 'exited')
    expect(reg.sendInput(snap.id, 'late')).toBe(false)
  })

  test('shutdownAll stops running processes', async () => {
    const reg = new ProcessRegistry()
    const snap = reg.start({ command: 'sleep 30', cwd: tmpdir() })
    await reg.shutdownAll(1500)
    const final = reg.list().find((p) => p.id === snap.id)
    expect(final?.status).not.toBe('running')
  })
})
