import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadConfig } from '../../src/config/index'

describe('[local.witchgrid] config', () => {
  let dir: string
  const saved = {
    config: process.env.EGIRL_CONFIG,
    endpoint: process.env.EGIRL_LOCAL_ENDPOINT,
    secret: process.env.WITCHGRID_SHARED_SECRET,
  }

  function write(local: string): void {
    const path = join(dir, 'egirl.toml')
    writeFileSync(path, `[workspace]\npath = "${dir}/workspace"\n\n[local]\nmodel = "m"\n${local}`)
    process.env.EGIRL_CONFIG = path
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'egirl-witchgrid-')).replace(/\\/g, '/')
    delete process.env.EGIRL_LOCAL_ENDPOINT
    delete process.env.WITCHGRID_SHARED_SECRET
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const [key, value] of [
      ['EGIRL_CONFIG', saved.config],
      ['EGIRL_LOCAL_ENDPOINT', saved.endpoint],
      ['WITCHGRID_SHARED_SECRET', saved.secret],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('is absent unless configured', () => {
    write('')
    expect(loadConfig().local.witchgrid).toBeUndefined()
  })

  test('carries url and profile, with no fallback when endpoint is unset', () => {
    write('\n[local.witchgrid]\nurl = "http://wg:8765"\nprofile = "chat-qwen"\n')
    expect(loadConfig().local.witchgrid).toEqual({ url: 'http://wg:8765', profile: 'chat-qwen' })
  })

  test('an explicit endpoint becomes the fallback', () => {
    write(
      'endpoint = "http://gpu:8080"\n\n[local.witchgrid]\nurl = "http://wg:8765"\nprofile = "p"\n',
    )
    expect(loadConfig().local.witchgrid?.fallbackEndpoint).toBe('http://gpu:8080')
  })

  test('the CP secret comes from WITCHGRID_SHARED_SECRET, then the toml', () => {
    write('\n[local.witchgrid]\nurl = "http://wg:8765"\nprofile = "p"\ntoken = "from-toml"\n')
    expect(loadConfig().local.witchgrid?.token).toBe('from-toml')
    process.env.WITCHGRID_SHARED_SECRET = 'from-env'
    expect(loadConfig().local.witchgrid?.token).toBe('from-env')
  })

  test('EGIRL_LOCAL_ENDPOINT bypasses Witchgrid for the run', () => {
    write('\n[local.witchgrid]\nurl = "http://wg:8765"\nprofile = "p"\n')
    process.env.EGIRL_LOCAL_ENDPOINT = 'http://bench-box:8080'
    const config = loadConfig()
    expect(config.local.witchgrid).toBeUndefined()
    expect(config.local.endpoint).toBe('http://bench-box:8080')
  })
})
