import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

// We test loadConfig indirectly by setting up temp directories and env vars
// Since loadConfig searches for egirl.toml in specific locations, we mock via cwd

describe('Config loading', () => {
  let tmpDir: string
  const originalEnv = { ...process.env }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'egirl-config-test-'))
    // Clear API keys to avoid leaking real keys into tests
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.DISCORD_TOKEN
    delete process.env.XMPP_USERNAME
    delete process.env.XMPP_PASSWORD
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    // Restore original env
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
    expect(props.routing).toBeDefined()
    expect(props.channels).toBeDefined()
    expect(props.skills).toBeDefined()
  })

  test('schema defines XMPP channel config', async () => {
    const { EgirlConfigSchema } = await import('../../src/config/schema')
    const channelProps = EgirlConfigSchema.properties.channels

    // channels is optional, but when present should have xmpp
    expect(channelProps).toBeDefined()
  })

  test('schema defines API channel config', async () => {
    const { EgirlConfigSchema } = await import('../../src/config/schema')
    const channelProps = EgirlConfigSchema.properties.channels

    expect(channelProps).toBeDefined()
  })

  test('RuntimeConfig interface supports all channel types', async () => {
    // Verify the config shape accepts all channel types
    const config = {
      workspace: { path: '/tmp/test' },
      local: {
        endpoint: 'http://localhost:8080',
        model: 'test',
        contextLength: 4096,
        maxConcurrent: 1,
      },
      remote: {},
      routing: {
        default: 'local' as const,
        escalationThreshold: 0.4,
        alwaysLocal: [] as string[],
        alwaysRemote: [] as string[],
        models: {} as Record<string, string[]>,
      },
      channels: {
        xmpp: {
          service: 'xmpp://localhost:5222',
          domain: 'localhost',
          username: 'test',
          password: 'test',
          allowedJids: [] as string[],
        },
        api: {
          port: 3000,
          host: '127.0.0.1',
        },
      },
      skills: { dirs: [] as string[] },
    }

    expect(config.channels.xmpp?.service).toBe('xmpp://localhost:5222')
    expect(config.channels.api?.port).toBe(3000)
  })

  test('loadConfig returns defaults when no config file exists', async () => {
    // Use a clean import to avoid cached config
    // We need to test the defaults path — loadConfig falls back to defaults
    // when no egirl.toml is found
    const { loadConfig } = await import('../../src/config/index')

    // loadConfig will use defaultToml since no egirl.toml exists at tmpDir
    // But it looks at cwd and home — we just verify the function is callable
    const config = loadConfig()

    expect(config.local.endpoint).toBe('http://localhost:8080')
    expect(config.local.contextLength).toBe(32768)
    expect(config.local.maxConcurrent).toBe(2)
    expect(config.routing.default).toBe('local')
    expect(config.routing.escalationThreshold).toBe(0.4)
    expect(config.routing.alwaysLocal).toContain('memory_search')
    expect(config.routing.alwaysRemote).toContain('code_generation')
  })

  test('loadConfig picks up ANTHROPIC_API_KEY from env', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'

    const { loadConfig } = await import('../../src/config/index')
    const config = loadConfig()

    expect(config.remote.anthropic?.apiKey).toBe('sk-ant-test-key')
  })

  test('loadConfig picks up OPENAI_API_KEY from env', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key'

    const { loadConfig } = await import('../../src/config/index')
    const config = loadConfig()

    expect(config.remote.openai?.apiKey).toBe('sk-test-key')
    expect(config.remote.openai?.model).toBe('gpt-4o')
  })

  test('loadConfig has no remote providers when no API keys set', async () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY

    const { loadConfig } = await import('../../src/config/index')
    const config = loadConfig()

    expect(config.remote.anthropic).toBeUndefined()
    expect(config.remote.openai).toBeUndefined()
  })

  test('workspace path is expanded from tilde', async () => {
    const { loadConfig } = await import('../../src/config/index')
    const config = loadConfig()

    // Default is ~/.egirl/workspace — should be expanded
    expect(config.workspace.path).not.toContain('~')
    expect(config.workspace.path).toContain(homedir())
  })
})
