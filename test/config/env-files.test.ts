/**
 * Per-instance secrets.
 *
 * One `.env` means every instance presents the same identity to every service it reaches. The
 * property that matters is that `.env.<instance>` actually wins — including over variables
 * already in `process.env`, because Bun loads `.env` into the environment before any of this
 * runs, and a loader that declined to overwrite would silently do nothing for exactly the keys
 * it exists to override.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadInstanceEnv, parseEnvFile } from '../../src/config/env-files'

const dirs: string[] = []
const touched: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const key of touched.splice(0)) delete process.env[key]
})

function sandbox(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'egirl-env-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return join(dir, 'egirl.toml')
}

describe('parseEnvFile', () => {
  test('reads plain assignments', () => {
    expect(parseEnvFile('A=1\nB=two')).toEqual({ A: '1', B: 'two' })
  })

  test('skips comments and blank lines', () => {
    expect(parseEnvFile('# note\n\nA=1\n')).toEqual({ A: '1' })
  })

  test('accepts an export prefix', () => {
    expect(parseEnvFile('export TOKEN=abc')).toEqual({ TOKEN: 'abc' })
  })

  test('strips surrounding quotes but keeps the contents intact', () => {
    // Tokens routinely contain # and $; a parser that reinterprets them corrupts the secret.
    expect(parseEnvFile('A="a#b"\nB=\'c$d\'')).toEqual({ A: 'a#b', B: 'c$d' })
  })

  test('drops a trailing comment only on unquoted values', () => {
    expect(parseEnvFile('A=value # trailing')).toEqual({ A: 'value' })
  })

  test('ignores lines that are not assignments', () => {
    expect(parseEnvFile('garbage\n=novalue\n1BAD=x')).toEqual({})
  })

  test('keeps an empty value rather than dropping the key', () => {
    expect(parseEnvFile('EMPTY=')).toEqual({ EMPTY: '' })
  })
})

describe('loadInstanceEnv', () => {
  test('no instance selected loads nothing', () => {
    expect(loadInstanceEnv(undefined, sandbox({}))).toBeUndefined()
  })

  test('a missing file is not an error', () => {
    expect(loadInstanceEnv('zero', sandbox({}))).toBeUndefined()
  })

  test('applies the instance file to the environment', () => {
    touched.push('WALD_TOKEN')
    const config = sandbox({ '.env.zero': 'WALD_TOKEN=zero-token\n' })
    const loaded = loadInstanceEnv('zero', config)
    expect(process.env.WALD_TOKEN).toBe('zero-token')
    expect(loaded?.keys).toEqual(['WALD_TOKEN'])
  })

  test('overrides a value already present in the environment', () => {
    // The whole point: `.env` is loaded by Bun before this runs, so its values are already in
    // process.env and indistinguishable from shell exports. Declining to overwrite would make
    // the instance file a no-op for every key it shares with `.env`.
    touched.push('WALD_TOKEN')
    process.env.WALD_TOKEN = 'shared-token'
    loadInstanceEnv('zero', sandbox({ '.env.zero': 'WALD_TOKEN=zero-token\n' }))
    expect(process.env.WALD_TOKEN).toBe('zero-token')
  })

  test('leaves variables the instance file does not mention', () => {
    touched.push('OTHER_TOKEN', 'WALD_TOKEN')
    process.env.OTHER_TOKEN = 'untouched'
    loadInstanceEnv('zero', sandbox({ '.env.zero': 'WALD_TOKEN=zero-token\n' }))
    expect(process.env.OTHER_TOKEN).toBe('untouched')
  })

  test('reports the path so a found-but-empty file is distinguishable from a missing one', () => {
    const config = sandbox({ '.env.zero': '# nothing set\n' })
    const loaded = loadInstanceEnv('zero', config)
    expect(loaded?.path).toEndWith('.env.zero')
    expect(loaded?.keys).toEqual([])
  })
})
