import {
  PEER_PROTOCOL,
  type PeerEntry,
  type PeerMessageResponse,
  peerTokenEnvKey,
} from './protocol'

/** Outcome of one POST /peer/message exchange, error text pre-formatted for tool output. */
export type PeerSendResult =
  | { ok: true; from: string; content: string }
  | { ok: false; error: string; timedOut?: boolean }

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

export function peerHeaders(peer: PeerEntry): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(peer.token && { authorization: `Bearer ${peer.token}` }),
  }
}

/**
 * Send one message to a peer egirl and wait for its agent-loop reply.
 * Shared by the peer_message tool and the report tool — one wire path, two callers.
 */
export async function postPeerMessage(
  peer: PeerEntry,
  from: string,
  message: string,
  timeoutMs: number,
): Promise<PeerSendResult> {
  try {
    const res = await fetchWithTimeout(
      `${peer.url}/peer/message`,
      {
        method: 'POST',
        headers: peerHeaders(peer),
        body: JSON.stringify({ protocol: PEER_PROTOCOL, from, message }),
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
        ok: false,
        error: `Peer "${peer.name}" returned HTTP ${res.status} ${res.statusText}${hint}${body ? `\n${body.slice(0, 500)}` : ''}`,
      }
    }

    const data = (await res.json()) as PeerMessageResponse
    return { ok: true, from: data.from ?? peer.name, content: data.content ?? '' }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('abort')) {
      return {
        ok: false,
        timedOut: true,
        error: `Peer "${peer.name}" did not reply within ${timeoutMs}ms. It may still be working — its side of the conversation is preserved, so you can ask again later.`,
      }
    }
    return { ok: false, error: `Failed to reach peer "${peer.name}": ${msg}` }
  }
}
