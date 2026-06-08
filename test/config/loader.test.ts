import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

describe('Config loading', () => {
  let tmpDir: string
  const originalCwd = process.cwd()
  const originalEnv = { ...process.env }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'egirl-config-test-'))
    delete process.env.DISCORD_TOKEN
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    process.chdir(originalCwd)
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

  test('loads explicit code agent config separately from Claude bridge config', async () => {
    process.chdir(tmpDir)
    writeFileSync(
      join(tmpDir, 'egirl.toml'),
      `
[workspace]
path = "${tmpDir}/workspace"

[local]
endpoint = "http://localhost:8080"
model = "test-model"
context_length = 8192
max_concurrent = 1

[channels.claude_code]
permission_mode = "bypassPermissions"
working_dir = "${tmpDir}/claude"

[channels.code_agent]
provider = "codex"
permission_mode = "default"
working_dir = "${tmpDir}/codex"

[skills]
dirs = ["{workspace}/skills"]
`,
    )

    const { loadConfig } = await import('../../src/config/index')
    const config = loadConfig()

    expect(config.channels.claudeCode?.permissionMode).toBe('bypassPermissions')
    expect(config.channels.claudeCode?.workingDir.endsWith('/claude')).toBe(true)
    expect(config.channels.codeAgent?.provider).toBe('codex')
    expect(config.channels.codeAgent?.permissionMode).toBe('default')
    expect(config.channels.codeAgent?.workingDir.endsWith('/codex')).toBe(true)
    expect(config.source.codeAgentUsesClaudeCodeFallback).toBe(false)
  })

  test('falls back to claude_code for code_agent when explicit config is absent', async () => {
    process.chdir(tmpDir)
    writeFileSync(
      join(tmpDir, 'egirl.toml'),
      `
[workspace]
path = "${tmpDir}/workspace"

[local]
endpoint = "http://localhost:8080"
model = "test-model"
context_length = 8192
max_concurrent = 1

[channels.claude_code]
permission_mode = "acceptEdits"
working_dir = "${tmpDir}/bridge"

[skills]
dirs = ["{workspace}/skills"]
`,
    )

    const { loadConfig } = await import('../../src/config/index')
    const config = loadConfig()

    expect(config.channels.claudeCode?.permissionMode).toBe('acceptEdits')
    expect(config.channels.codeAgent?.provider).toBe('claude')
    expect(config.channels.codeAgent?.permissionMode).toBe('acceptEdits')
    expect(config.channels.codeAgent?.workingDir.endsWith('/bridge')).toBe(true)
    expect(config.source.codeAgentUsesClaudeCodeFallback).toBe(true)
  })
})
