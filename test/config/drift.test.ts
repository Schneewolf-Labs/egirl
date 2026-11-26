import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchConfigFiles } from '../../src/config/drift'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'drift-'))
  const main = join(dir, 'egirl.toml')
  const frag = join(dir, 'egirl.d', 'jaeger.toml')
  mkdirSync(join(dir, 'egirl.d'))
  writeFileSync(main, '')
  writeFileSync(frag, '')
  const past = new Date(Date.now() - 60_000)
  utimesSync(main, past, past)
  utimesSync(frag, past, past)
  return { dir, main, frag }
}

describe('config drift', () => {
  test('nothing changed: nothing to report', () => {
    const { main, frag } = setup()
    expect(watchConfigFiles({ path: main, fragments: [frag] }).changed()).toEqual([])
  })

  test('an edited, a removed and an added file are each named', () => {
    const { dir, main, frag } = setup()
    const drift = watchConfigFiles({ path: main, fragments: [frag] })
    writeFileSync(main, 'theme = "neon"\n')
    rmSync(frag)
    writeFileSync(join(dir, 'egirl.d', 'emma.toml'), '')
    expect(drift.changed()).toEqual([
      'egirl.toml (edited)',
      'egirl.d/jaeger.toml (removed)',
      'egirl.d/emma.toml (added)',
    ])
  })

  test('no config file: nothing to watch', () => {
    expect(watchConfigFiles({}).changed()).toEqual([])
  })
})
