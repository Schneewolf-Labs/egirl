/**
 * Peer discovery against an agent registry.
 *
 * The properties that matter are the ones that decide whether a fleet stays trustworthy as it
 * grows: a registry must not be able to redirect a peer an operator pinned by hand, must not
 * make the agent fail to start when it is unreachable, and must not turn every unrelated
 * agent in a shared hub into something egirl will try to message.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { discoverPeers, mergePeers, registerSelf } from '../../src/peers/discovery'
import { PEER_PROTOCOL, type PeerEntry } from '../../src/peers/protocol'
import type { Tool, ToolResult } from '../../src/tools/types'

function tool(name: string, result: Partial<ToolResult> & { output: string }): Tool {
  return {
    definition: { name, description: '', parameters: { type: 'object', properties: {} } },
    execute: async () => ({ success: true, ...result }) as ToolResult,
  }
}

const AGENTS = [
  { slug: 'kira', endpoint_url: 'https://kira.local/', protocol: PEER_PROTOCOL, status: 'active' },
  {
    slug: 'scribe',
    endpoint_url: 'https://scribe.local',
    protocol: PEER_PROTOCOL,
    status: 'active',
  },
  // Not an egirl peer -- a Wald shared by other agents must not pollute the peer list.
  { slug: 'some-mcp-bot', endpoint_url: 'https://bot.local', protocol: 'mcp', status: 'active' },
  // Registered but never published an address; unreachable, so not a peer.
  { slug: 'addressless', endpoint_url: null, protocol: PEER_PROTOCOL, status: 'active' },
  {
    slug: 'retired-one',
    endpoint_url: 'https://old.local',
    protocol: PEER_PROTOCOL,
    status: 'retired',
  },
]

const listTool = tool('wald_list_agents', { output: JSON.stringify(AGENTS) })

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('EGIRL_PEER_')) delete process.env[k]
  }
})

describe('discoverPeers', () => {
  test('returns peers speaking the egirl protocol', async () => {
    const peers = await discoverPeers({ tools: [listTool], selfName: 'nobody' })
    expect(peers.map((p) => p.name).sort()).toEqual(['kira', 'scribe'])
  })

  test('excludes this instance', async () => {
    const peers = await discoverPeers({ tools: [listTool], selfName: 'kira' })
    expect(peers.map((p) => p.name)).toEqual(['scribe'])
  })

  test('ignores agents that do not speak the peer protocol', async () => {
    const peers = await discoverPeers({ tools: [listTool], selfName: 'x' })
    expect(peers.find((p) => p.name === 'some-mcp-bot')).toBeUndefined()
  })

  test('ignores agents with no published address', async () => {
    // Inventing a URL would produce a peer that fails at call time rather than one that
    // simply is not there.
    const peers = await discoverPeers({ tools: [listTool], selfName: 'x' })
    expect(peers.find((p) => p.name === 'addressless')).toBeUndefined()
  })

  test('ignores agents that are not active', async () => {
    const peers = await discoverPeers({ tools: [listTool], selfName: 'x' })
    expect(peers.find((p) => p.name === 'retired-one')).toBeUndefined()
  })

  test('strips trailing slashes so URLs join predictably', async () => {
    const peers = await discoverPeers({ tools: [listTool], selfName: 'x' })
    expect(peers.find((p) => p.name === 'kira')?.url).toBe('https://kira.local')
  })

  test('takes the token from the environment, not the registry', async () => {
    // Wald stores a reference to where a secret lives, never the secret, so the token can
    // only come from .env.
    process.env.EGIRL_PEER_KIRA_TOKEN = 'tok-abc'
    const peers = await discoverPeers({ tools: [listTool], selfName: 'x' })
    expect(peers.find((p) => p.name === 'kira')?.token).toBe('tok-abc')
    expect(peers.find((p) => p.name === 'scribe')?.token).toBeUndefined()
  })

  test('an unreachable registry yields no peers rather than throwing', async () => {
    const failing = tool('wald_list_agents', { success: false, output: 'connection refused' })
    expect(await discoverPeers({ tools: [failing], selfName: 'x' })).toEqual([])
  })

  test('a registry that answers with prose yields no peers', async () => {
    const prose = tool('wald_list_agents', { output: 'Error executing tool: nope' })
    expect(await discoverPeers({ tools: [prose], selfName: 'x' })).toEqual([])
  })

  test('no registry configured is not an error', async () => {
    expect(await discoverPeers({ tools: [], selfName: 'x' })).toEqual([])
  })

  test('honours a non-default registry name', async () => {
    const other = tool('hub_list_agents', { output: JSON.stringify(AGENTS) })
    expect(await discoverPeers({ tools: [other], selfName: 'x', registry: 'hub' })).toHaveLength(2)
    expect(await discoverPeers({ tools: [other], selfName: 'x' })).toEqual([])
  })
})

describe('mergePeers', () => {
  const configured: PeerEntry[] = [{ name: 'kira', url: 'https://pinned.local', timeoutMs: 1000 }]
  const discovered: PeerEntry[] = [
    { name: 'kira', url: 'https://registry-says.local', timeoutMs: 120_000 },
    { name: 'scribe', url: 'https://scribe.local', timeoutMs: 120_000 },
  ]

  test('a hand-pinned peer is not overridden by the registry', () => {
    // Someone pinned that URL for a reason; a registry quietly winning is a confusing way to
    // discover it changed.
    const merged = mergePeers(configured, discovered)
    expect(merged.find((p) => p.name === 'kira')?.url).toBe('https://pinned.local')
  })

  test('adds peers the config did not name', () => {
    expect(
      mergePeers(configured, discovered)
        .map((p) => p.name)
        .sort(),
    ).toEqual(['kira', 'scribe'])
  })

  test('name matching is case-insensitive', () => {
    const merged = mergePeers(
      [{ name: 'KIRA', url: 'https://pinned.local', timeoutMs: 1 }],
      discovered,
    )
    expect(merged.filter((p) => p.name.toLowerCase() === 'kira')).toHaveLength(1)
  })

  test('no discovery leaves configured peers untouched', () => {
    expect(mergePeers(configured, [])).toEqual(configured)
  })
})

describe('registerSelf', () => {
  test('does not register without a self URL', async () => {
    // Publishing an address we do not have would advertise an unreachable peer.
    const reg = tool('wald_register_agent', { output: '{}' })
    expect(await registerSelf({ tools: [reg], selfName: 'kira' })).toBe(false)
  })

  test('registers with the peer protocol as the discriminator', async () => {
    let seen: Record<string, unknown> = {}
    const reg: Tool = {
      definition: { name: 'wald_register_agent', description: '', parameters: {} },
      execute: async (params) => {
        seen = params
        return { success: true, output: '{}' }
      },
    }
    const ok = await registerSelf({
      tools: [reg],
      selfName: 'kira',
      selfUrl: 'https://kira.local',
      capabilities: ['coding'],
    })
    expect(ok).toBe(true)
    expect(seen.slug).toBe('kira')
    expect(seen.protocol).toBe(PEER_PROTOCOL)
    expect(seen.endpoint_url).toBe('https://kira.local')
  })
})
