import {
  PEER_PROTOCOL,
  type PeerEntry,
  type PeerIdentity,
  type PeerMessageResponse,
  peerTokenEnvKey,
} from '../../peers/protocol'
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

function peerHeaders(peer: PeerEntry): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(peer.token && { authorization: `Bearer ${peer.token}` }),
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
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

      try {
        const res = await fetchWithTimeout(
          `${peer.url}/peer/message`,
          {
            method: 'POST',
            headers: peerHeaders(peer),
            body: JSON.stringify({ protocol: PEER_PROTOCOL, from: config.selfName, message }),
          },
          timeoutMs,
        )

        if (!res.ok) {
          const body = await res.text().catch(() => '')
          const hint =
            res.status === 401
              ? ` (set ${peerTokenEnvKey(peer.name)} in .env to that instance's EGIRL_API_TOKEN)`
              : ''
          return {
            success: false,
            output: `Peer "${peer.name}" returned HTTP ${res.status} ${res.statusText}${hint}${body ? `\n${body.slice(0, 500)}` : ''}`,
          }
        }

        const data = (await res.json()) as PeerMessageResponse
        let content = data.content ?? ''
        if (content.length > MAX_REPLY_LENGTH) {
          content = `${content.slice(0, MAX_REPLY_LENGTH)}\n\n[Truncated — reply exceeded ${MAX_REPLY_LENGTH} characters]`
        }
        return { success: true, output: `${data.from ?? peer.name} replied:\n\n${content}` }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes('abort')) {
          return {
            success: false,
            output: `Peer "${peer.name}" did not reply within ${timeoutMs}ms. It may still be working — its side of the conversation is preserved, so you can ask again later.`,
          }
        }
        return { success: false, output: `Failed to reach peer "${peer.name}": ${msg}` }
      }
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
            const res = await fetchWithTimeout(
              `${peer.url}/peer/identity`,
              { headers: peerHeaders(peer) },
              IDENTITY_TIMEOUT,
            )
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
