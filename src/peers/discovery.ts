/**
 * Resolve peers from a Wald agent registry instead of a hand-maintained list.
 *
 * Declaring peers statically means every instance carries an entry for every other instance:
 * N instances, N-1 entries each, and adding one means editing N configs. A registry inverts
 * that — each instance announces itself once and asks who else is there.
 *
 * Discovery covers *addresses*, not credentials. Wald deliberately stores a reference to
 * where a secret lives rather than the secret, so it can tell you a peer exists at a URL and
 * cannot hand you the token to talk to it. Tokens keep coming from
 * `EGIRL_PEER_<NAME>_TOKEN`, exactly as with static peers. That still removes the part that
 * actually churns: a peer that moves, or a new instance appearing, needs no config edit
 * anywhere.
 *
 * The registry is reached through the MCP tools already connected for it, rather than a
 * second HTTP client — one connection, one credential, one place it can be misconfigured.
 *
 * A registry that is down is not fatal. Static peers still work, discovery contributes
 * nothing, and the agent starts: the same rule the MCP client follows, because an optional
 * source of addresses should never be able to stop an agent from running.
 */

import type { Tool } from '../tools/types'
import { PEER_PROTOCOL, type PeerEntry, peerTokenEnvKey } from './protocol'

/** What a Wald `list_agents` row looks like once parsed. */
interface RegistryAgent {
  slug: string
  name?: string
  endpoint_url?: string | null
  protocol?: string
  status?: string
  capabilities?: string[]
}

export interface DiscoveryOptions {
  /** Tools from the connected MCP servers; the registry's are namespaced `<server>_<tool>`. */
  tools: Tool[]
  /** This instance's own name, so it does not discover itself as a peer. */
  selfName: string
  /** MCP server name the registry is configured under. */
  registry?: string
  /** Advertise this instance to the registry before reading it. */
  selfUrl?: string
  capabilities?: string[]
  timeoutMs?: number
}

function findTool(tools: Tool[], registry: string, name: string): Tool | undefined {
  return tools.find((t) => t.definition.name === `${registry}_${name}`)
}

/**
 * MCP tools return a string. Wald's return JSON, but a failure returns prose, so parse
 * defensively rather than assuming — a registry that answers with an error message should
 * degrade to "no peers", not throw during startup.
 */
function parseAgents(output: string): RegistryAgent[] {
  try {
    const parsed = JSON.parse(output)
    if (Array.isArray(parsed)) return parsed as RegistryAgent[]
    // Wald concatenates content blocks with newlines when several are returned.
    return []
  } catch {
    const rows: RegistryAgent[] = []
    for (const chunk of output.split(/\n(?=\{)/)) {
      try {
        const one = JSON.parse(chunk)
        if (one && typeof one === 'object') rows.push(one as RegistryAgent)
      } catch {
        // Not JSON — a prose error or a partial block. Skip it.
      }
    }
    return rows
  }
}

/** Announce this instance so other agents can find it. Best-effort. */
export async function registerSelf(opts: DiscoveryOptions): Promise<boolean> {
  const registry = opts.registry ?? 'wald'
  const tool = findTool(opts.tools, registry, 'register_agent')
  if (!tool || !opts.selfUrl) return false

  const result = await tool.execute(
    {
      slug: opts.selfName,
      name: opts.selfName,
      description: `egirl instance reachable over ${PEER_PROTOCOL}`,
      capabilities: opts.capabilities ?? [],
      endpoint_url: opts.selfUrl,
      // The registry's own `protocol` field is the discriminator: only rows speaking the
      // egirl peer protocol are peers, so a Wald full of unrelated agents stays harmless.
      protocol: PEER_PROTOCOL,
    },
    '/tmp',
  )
  return result.success
}

/**
 * Peers from the registry, excluding this instance.
 *
 * Rows without an endpoint are skipped: an agent that has not published an address cannot be
 * messaged, and inventing one would produce a peer that fails at call time instead of simply
 * not appearing.
 */
export async function discoverPeers(opts: DiscoveryOptions): Promise<PeerEntry[]> {
  const registry = opts.registry ?? 'wald'
  const tool = findTool(opts.tools, registry, 'list_agents')
  if (!tool) return []

  const result = await tool.execute({}, '/tmp')
  if (!result.success) return []

  const self = opts.selfName.toLowerCase()
  const peers: PeerEntry[] = []
  for (const agent of parseAgents(String(result.output))) {
    if (!agent.slug || !agent.endpoint_url) continue
    if (agent.protocol !== PEER_PROTOCOL) continue
    if (agent.slug.toLowerCase() === self) continue
    if (agent.status && agent.status !== 'active') continue

    const token = process.env[peerTokenEnvKey(agent.slug)]
    peers.push({
      name: agent.slug,
      url: agent.endpoint_url.replace(/\/+$/, ''),
      ...(token && { token }),
      timeoutMs: opts.timeoutMs ?? 120_000,
    })
  }
  return peers
}

/**
 * Static peers plus discovered ones, with static winning on a name collision.
 *
 * Config beats registry deliberately: an operator who pinned a peer's URL by hand did so for
 * a reason, and a registry entry silently overriding it would be a very confusing way to
 * find that out.
 */
export function mergePeers(configured: PeerEntry[], discovered: PeerEntry[]): PeerEntry[] {
  const byName = new Map(configured.map((p) => [p.name.toLowerCase(), p]))
  for (const peer of discovered) {
    if (!byName.has(peer.name.toLowerCase())) byName.set(peer.name.toLowerCase(), peer)
  }
  return [...byName.values()]
}
