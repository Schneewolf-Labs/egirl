import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parse } from 'smol-toml'
import { runInit } from '../../src/commands/init'

test('init preserves Windows paths in valid TOML', async () => {
  const originalCwd = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), 'egirl-init-'))
  const workspace = 'C:\\Users\\Developer\\Game Projects\\workspace'
  try {
    process.chdir(dir)
    await runInit(['--workspace', workspace])
    const config = parse(readFileSync(join(dir, 'egirl.toml'), 'utf8'))
    expect((config.workspace as { path: string }).path).toBe(workspace)
  } finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})
