import { errorMessage } from '../util/errors'
import {
  PEER_PROTOCOL,
  type PeerEntry,
  type PeerMessageResponse,
  peerTokenEnvKey,
} from './protocol'

/** Outcome of one POST /peer/message exchange, error text pre-formatted for tool output. */
export type PeerSendResult =
  | { ok: true; from: string; content: string }
  // `busy` is a *successful* fast reply, not a failure: the peer is mid-task and said so at once
  // rather than making us wait out a turn. Distinct from ok:true so the caller can choose to
  // retry later rather than treat "busy" as the peer's actual answer.
  | { ok: true; busy: true; from: string; content: string }
  | { ok: false; error: string; timedOut?: boolean }

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
    const res = await fetch(`${peer.url}/peer/message`, {
      method: 'POST',
      headers: peerHeaders(peer),
      body: JSON.stringify({ protocol: PEER_PROTOCOL, from, message }),
      signal: AbortSignal.timeout(timeoutMs),
    })

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

    const data = (await res.json()) as PeerMessageResponse & { busy?: boolean }
    if (data.busy) {
      return { ok: true, busy: true, from: data.from ?? peer.name, content: data.content ?? '' }
    }
    return { ok: true, from: data.from ?? peer.name, content: data.content ?? '' }
  } catch (error) {
    const msg = errorMessage(error)
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        ok: false,
        timedOut: true,
        error: `Peer "${peer.name}" did not reply within ${timeoutMs}ms. It may still be working — its side of the conversation is preserved, so you can ask again later.`,
      }
    }
    return { ok: false, error: `Failed to reach peer "${peer.name}": ${msg}` }
  }
}
