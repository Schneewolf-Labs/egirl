import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadConfig } from '../../src/config/index'

describe('[operator] config', () => {
  let dir: string
  const savedConfig = process.env.EGIRL_CONFIG

  function write(section: string): void {
    const path = join(dir, 'egirl.toml')
    writeFileSync(
      path,
      `[workspace]\npath = "${dir}/workspace"\n\n[local]\nmodel = "m"\n${section}`,
    )
    process.env.EGIRL_CONFIG = path
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'egirl-operator-')).replace(/\\/g, '/')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedConfig === undefined) delete process.env.EGIRL_CONFIG
    else process.env.EGIRL_CONFIG = savedConfig
  })

  test('is absent unless configured: the local loop drives', () => {
    write('')
    expect(loadConfig().operator).toBeUndefined()
  })

  test('names the Claude operator and its model', () => {
    write('\n[operator]\nprovider = "claude"\nmodel = "opus"\n')
    expect(loadConfig().operator).toEqual({ provider: 'claude', model: 'opus' })
  })

  test('an instance fragment can choose its own operator', () => {
    write('\n[instances.claude]\n[instances.claude.operator]\nprovider = "claude"\n')
    expect(loadConfig({ instance: 'claude' }).operator).toEqual({ provider: 'claude' })
  })

  test('an unknown provider is rejected', () => {
    write('\n[operator]\nprovider = "gpt"\n')
    expect(() => loadConfig()).toThrow()
  })
})
