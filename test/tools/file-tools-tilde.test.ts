import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTool } from '../../src/tools/builtin/read'
import { writeTool } from '../../src/tools/builtin/write'

// Bun's os.homedir() does not follow a HOME changed at runtime, so the test writes under the real
// home, in a directory of its own that it removes afterwards.
const dir = `.egirl-tilde-test-${process.pid}-${Date.now()}`

afterEach(() => {
  rmSync(join(homedir(), dir), { recursive: true, force: true })
})

describe('file tools and ~', () => {
  test('write_file to ~/… lands in home, not in a "~" directory inside the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-ws-'))
    const r = await writeTool.execute({ path: `~/${dir}/repos.md`, content: 'hello' }, ws)
    expect(r.success).toBe(true)
    expect(readFileSync(join(homedir(), dir, 'repos.md'), 'utf8')).toBe('hello')
    expect(existsSync(join(ws, '~'))).toBe(false)
    const back = await readTool.execute({ path: `~/${dir}/repos.md` }, ws)
    expect(back.output).toContain('hello')
  })
})
