/**
 * Scaffolding a new instance.
 *
 * The properties worth pinning are the ones whose failure is delayed: a port handed out twice
 * does not break until both instances run at once, and a rendered TOML block that drops the API
 * port does not break until the second one starts.
 */

import { describe, expect, test } from 'bun:test'
import { createServer } from 'net'
import {
  collectConfiguredPorts,
  findFreePort,
  instanceNames,
  isValidName,
  profileNames,
  renderInstanceToml,
  renderPersonaFiles,
} from '../../src/instances/scaffold'

const CONFIG = {
  channels: { api: { port: 3000 } },
  profiles: {
    'local-codex': { channels: { api: { port: 3001 } } },
    'no-api': { local: { endpoint: 'http://x' } },
  },
  instances: {
    kira: { profile: 'local-codex' },
    ops: { channels: { api: { port: 3005 } } },
  },
}

describe('collectConfiguredPorts', () => {
  test('finds ports declared at every level', () => {
    // Top-level, per-profile and per-instance are three separate places a port can hide; a scan
    // that checks only one of them will reissue a port that is already spoken for.
    expect(collectConfiguredPorts(CONFIG).sort()).toEqual([3000, 3001, 3005])
  })

  test('ignores entries with no api channel', () => {
    expect(collectConfiguredPorts(CONFIG)).not.toContain(undefined)
  })

  test('a config with no ports is not an error', () => {
    expect(collectConfiguredPorts({})).toEqual([])
    expect(collectConfiguredPorts(undefined)).toEqual([])
  })
})

describe('findFreePort', () => {
  test('skips ports claimed in config', async () => {
    const port = await findFreePort([3000, 3001], 3000)
    expect(port).toBeGreaterThan(3001)
  })

  test('skips a port that is bound but not in config', async () => {
    // The case config alone cannot see: something that is not egirl already owns the port.
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(3456, '127.0.0.1', resolve))
    try {
      const port = await findFreePort([], 3456)
      expect(port).toBeGreaterThan(3456)
    } finally {
      server.close()
    }
  })
})

describe('isValidName', () => {
  test('accepts names usable as both a TOML key and a directory', () => {
    expect(isValidName('zero')).toBe(true)
    expect(isValidName('ops-big')).toBe(true)
    expect(isValidName('a_1')).toBe(true)
  })

  test('rejects names that would need quoting or escape the workspace root', () => {
    expect(isValidName('Zero')).toBe(false)
    expect(isValidName('../etc')).toBe(false)
    expect(isValidName('has space')).toBe(false)
    expect(isValidName('')).toBe(false)
    expect(isValidName('-leading')).toBe(false)
  })
})

describe('renderInstanceToml', () => {
  test('an instance reusing a profile still gets its own port', () => {
    // Two instances sharing a profile would otherwise share its API port, and the second to
    // start would die on bind.
    const toml = renderInstanceToml({ name: 'zero', theme: 'neon', profile: 'big-box', port: 3002 })
    expect(toml).toContain('[instances.zero.channels.api]')
    expect(toml).toContain('port = 3002')
    expect(toml).toContain('profile = "big-box"')
    expect(toml).not.toContain('[profiles.zero.local]')
  })

  test('an endpoint defines a profile named after the instance', () => {
    const toml = renderInstanceToml({
      name: 'zero',
      theme: 'neon',
      endpoint: 'http://10.0.0.5:8214',
      model: 'qwen',
      port: 3002,
    })
    expect(toml).toContain('[profiles.zero.local]')
    expect(toml).toContain('endpoint = "http://10.0.0.5:8214"')
    expect(toml).toContain('profile = "zero"')
    // The port belongs to the profile here, so an instance-level override would be redundant.
    expect(toml).not.toContain('[instances.zero.channels.api]')
  })

  test('parses as TOML and lands the instance where the loader looks for it', async () => {
    const { parse } = await import('smol-toml')
    const rendered = renderInstanceToml({
      name: 'zero',
      theme: 'neon',
      profile: 'big-box',
      port: 3002,
    })
    const parsed = parse(rendered) as Record<string, Record<string, unknown>>
    expect(instanceNames(parsed)).toEqual(['zero'])
    expect(parsed.personas?.zero).toEqual({ theme: 'neon' })
  })

  test('appending to an existing config keeps both instances', async () => {
    const { parse } = await import('smol-toml')
    const base = '[instances.kira]\nprofile = "local-codex"\npersona = "kira"\n'
    const merged = parse(
      base + renderInstanceToml({ name: 'zero', theme: 'neon', profile: 'big-box', port: 3002 }),
    )
    expect(instanceNames(merged).sort()).toEqual(['kira', 'zero'])
  })
})

describe('renderPersonaFiles', () => {
  test('writes the three files loaded into the system prompt', () => {
    const files = renderPersonaFiles('zero')
    expect(Object.keys(files).sort()).toEqual(['AGENTS.md', 'IDENTITY.md', 'SOUL.md'])
  })

  test('substitutes the name rather than inheriting another persona', () => {
    const files = renderPersonaFiles('zero')
    expect(files['IDENTITY.md']).toContain('Zero')
    expect(files['SOUL.md']).toContain('Zero')
    // A scaffold that shipped the default persona's voice would have to be edited out first.
    expect(files['SOUL.md']).not.toContain('Kira')
    expect(files['IDENTITY.md']).not.toContain('Kira')
  })

  test('keeps the delegation instruction, which is the load-bearing part', () => {
    expect(renderPersonaFiles('zero')['AGENTS.md']).toContain('code_agent')
  })
})

describe('name accessors', () => {
  test('read instances and profiles out of a parsed config', () => {
    expect(instanceNames(CONFIG).sort()).toEqual(['kira', 'ops'])
    expect(profileNames(CONFIG).sort()).toEqual(['local-codex', 'no-api'])
  })

  test('tolerate a config with neither', () => {
    expect(instanceNames({})).toEqual([])
    expect(profileNames({})).toEqual([])
  })
})
