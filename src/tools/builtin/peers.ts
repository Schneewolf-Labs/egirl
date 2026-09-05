import { peerHeaders, postPeerMessage } from '../../peers/client'
import type { PeerEntry, PeerIdentity } from '../../peers/protocol'
import type { Tool, ToolResult } from '../types'

const IDENTITY_TIMEOUT = 5000
const MAX_REPLY_LENGTH = 30000

export interface PeerToolsConfig {
  /** How this instance identifies itself in the `from` field. */
  selfName: string
  peers: PeerEntry[]
}

function findPeer(peers: PeerEntry[], name: string): PeerEntry | undefined {
  return peers.find((p) => p.name.toLowerCase() === name.toLowerCase())
}

export function createPeerTools(config: PeerToolsConfig): {
  peerMessageTool: Tool
  peerListTool: Tool
} {
  const names = config.peers.map((p) => p.name).join(', ')

  const peerMessageTool: Tool = {
    definition: {
      name: 'peer_message',
      description:
        'Send a message to another egirl agent (a "peer") and wait for its reply. ' +
        'The peer runs its own agent loop — with its own memory, tools, and machine — and its final reply comes back as the result. ' +
        'Use for agent-to-agent work: asking a peer to check something on its machine, sharing findings, splitting work. ' +
        `Replies can take a while since the peer may be running tools. Configured peers: ${names}.`,
      parameters: {
        type: 'object',
        properties: {
          peer: {
            type: 'string',
            description: `Name of the configured peer to message (one of: ${names})`,
          },
          message: {
            type: 'string',
            description:
              'The message. Be specific and self-contained — the peer does not share your conversation context.',
          },
          timeout_ms: {
            type: 'number',
            description:
              'Max time to wait for the reply in milliseconds (default: per-peer config)',
          },
        },
        required: ['peer', 'message'],
      },
    },

    async execute(params: Record<string, unknown>, _cwd: string): Promise<ToolResult> {
      const peerName = params.peer as string | undefined
      const message = params.message as string | undefined
      if (!peerName?.trim() || !message?.trim()) {
        return { success: false, output: 'peer and message are required' }
      }

      const peer = findPeer(config.peers, peerName)
      if (!peer) {
        return {
          success: false,
          output: `Unknown peer "${peerName}". Configured peers: ${names}`,
        }
      }

      const timeoutMs = (params.timeout_ms as number | undefined) ?? peer.timeoutMs

      const result = await postPeerMessage(peer, config.selfName, message, timeoutMs)
      if (!result.ok) return { success: false, output: result.error }
      // A busy reply is not the peer's answer — it is "ask me later". Say so plainly so the
      // model retries or moves on instead of acting on the busy notice as if it were content.
      if ('busy' in result && result.busy) {
        return {
          success: true,
          output: `${result.from} is busy and did not answer: ${result.content}`,
        }
      }
      let content = result.content
      if (content.length > MAX_REPLY_LENGTH) {
        content = `${content.slice(0, MAX_REPLY_LENGTH)}\n\n[Truncated — reply exceeded ${MAX_REPLY_LENGTH} characters]`
      }
      return { success: true, output: `${result.from} replied:\n\n${content}` }
    },
  }

  const peerListTool: Tool = {
    definition: {
      name: 'peer_list',
      description:
        'List the configured peer egirl agents and check whether each one is currently reachable.',
      parameters: { type: 'object', properties: {}, required: [] },
    },

    async execute(_params: Record<string, unknown>, _cwd: string): Promise<ToolResult> {
      const lines = await Promise.all(
        config.peers.map(async (peer) => {
          try {
            const res = await fetch(`${peer.url}/peer/identity`, {
              headers: peerHeaders(peer),
              signal: AbortSignal.timeout(IDENTITY_TIMEOUT),
            })
            if (!res.ok) {
              return `${peer.name} — ${peer.url} — unreachable (HTTP ${res.status})`
            }
            const identity = (await res.json()) as PeerIdentity
            return `${peer.name} — ${peer.url} — online as "${identity.name}" (${identity.protocol})`
          } catch {
            return `${peer.name} — ${peer.url} — unreachable`
          }
        }),
      )
      return { success: true, output: lines.join('\n') }
    },
  }

  return { peerMessageTool, peerListTool }
}
