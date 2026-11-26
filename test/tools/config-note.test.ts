import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editTool } from '../../src/tools/builtin/edit'
import { writeTool } from '../../src/tools/builtin/write'
import { startupConfigNote } from '../../src/tools/config-note'
import { ToolExecutor } from '../../src/tools/executor'

const dir = mkdtempSync(join(tmpdir(), 'cfgnote-'))
const config = join(dir, 'egirl.toml')
mkdirSync(join(dir, 'egirl.d'))

describe('startup config note', () => {
  test('editing egirl.toml or a fragment says it applies at restart', () => {
    expect(startupConfigNote('edit_file', { path: 'egirl.toml' }, dir, config)).toContain(
      'takes effect after the instance restarts',
    )
    expect(
      startupConfigNote('write_file', { path: 'egirl.d/jaeger.toml' }, dir, config),
    ).toBeDefined()
    expect(startupConfigNote('write_file', { path: config }, '/elsewhere', config)).toBeDefined()
  })

  test('other files, other tools, and no config leave the result alone', () => {
    expect(startupConfigNote('write_file', { path: 'notes.toml' }, dir, config)).toBeUndefined()
    expect(
      startupConfigNote('write_file', { path: 'egirl.d/readme.md' }, dir, config),
    ).toBeUndefined()
    expect(startupConfigNote('read_file', { path: 'egirl.toml' }, dir, config)).toBeUndefined()
    expect(startupConfigNote('edit_file', { path: 'egirl.toml' }, dir, undefined)).toBeUndefined()
  })

  test('the executor appends it to a successful edit, not a failed one', async () => {
    const executor = new ToolExecutor()
    executor.registerAll([writeTool, editTool])
    executor.setConfigPath(config)
    const wrote = await executor.execute(
      {
        id: '1',
        name: 'write_file',
        arguments: { path: 'egirl.d/jaeger.toml', content: 'x = 1\n' },
      },
      dir,
    )
    expect(wrote.success).toBe(true)
    expect(wrote.output).toContain('[Note: this is egirl config')
    writeFileSync(config, 'a = 1\n')
    const failed = await executor.execute(
      {
        id: '2',
        name: 'edit_file',
        arguments: { path: 'egirl.toml', old_text: 'nope', new_text: 'b' },
      },
      dir,
    )
    expect(failed.success).toBe(false)
    expect(failed.output).not.toContain('[Note:')
  })
})
