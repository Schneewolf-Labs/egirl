import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

describe('Config loading', () => {
  let tmpDir: string
  const originalEnv = { ...process.env }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'egirl-config-test-'))
    delete process.env.DISCORD_TOKEN
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    Object.assign(process.env, originalEnv)
  })

  test('config schema exports RuntimeConfig type', async () => {
    const { EgirlConfigSchema } = await import('../../src/config/schema')
    expect(EgirlConfigSchema).toBeDefined()
    expect(EgirlConfigSchema.type).toBe('object')
  })

  test('schema has required top-level sections', async () => {
    const { EgirlConfigSchema } = await import('../../src/config/schema')
    const props = EgirlConfigSchema.properties

    expect(props.workspace).toBeDefined()
    expect(props.local).toBeDefined()
    expect(props.channels).toBeDefined()
    expect(props.skills).toBeDefined()
  })

  test('loadConfig returns a usable config', async () => {
    const { loadConfig } = await import('../../src/config/index')
    const config = loadConfig()

    expect(config.local.endpoint).toBeDefined()
    expect(config.local.contextLength).toBeGreaterThan(0)
    expect(config.local.maxConcurrent).toBeGreaterThan(0)
  })

  test('workspace path is expanded from tilde', async () => {
    const { loadConfig } = await import('../../src/config/index')
    const config = loadConfig()

    expect(config.workspace.path).not.toContain('~')
    expect(config.workspace.path).toContain(homedir())
  })

  test('safety defaults to block mode', async () => {
    const { loadConfig } = await import('../../src/config/index')
    const config = loadConfig()

    expect(config.safety.commandFilter.enabled).toBe(true)
    expect(config.safety.commandFilter.mode).toBe('block')
  })
})
