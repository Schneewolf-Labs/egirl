/**
 * egirl-peer/1 — the cross-egirl agent-to-agent protocol.
 *
 * Two egirl instances talk over the existing HTTP API: the sender's
 * `peer_message` tool POSTs to the receiver's `/peer/message` endpoint, the
 * receiver runs the message through its own agent loop, and the final reply
 * comes back in the response body. Synchronous request/reply, one bearer
 * token per peer, no discovery, no capability negotiation — peers are
 * declared statically in egirl.toml.
 */

export const PEER_PROTOCOL = 'egirl-peer/1'

/** Body of POST /peer/message. */
export interface PeerMessageRequest {
  /** Protocol version, e.g. "egirl-peer/1". Optional on the wire so v1 can read future senders. */
  protocol?: string
  /** Name the sending agent goes by (its instance name). */
  from: string
  message: string
}

/** Response body of POST /peer/message. */
export interface PeerMessageResponse {
  protocol: string
  /** Name of the replying agent. */
  from: string
  /** Final agent-loop reply text. */
  content: string
  session_id: string
  turns?: number
}

/** Response body of GET /peer/identity — the ping/handshake. */
export interface PeerIdentity {
  service: string
  protocol: string
  name: string
}

/** One configured remote peer, resolved from [[peers]] in egirl.toml + .env. */
export interface PeerEntry {
  name: string
  url: string
  token?: string
  timeoutMs: number
}

/** .env variable holding the bearer token for a named peer (its EGIRL_API_TOKEN). */
export function peerTokenEnvKey(name: string): string {
  return `EGIRL_PEER_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOKEN`
}

export function sanitizePeerName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (cleaned || 'peer').slice(0, 64)
}

/** Each peer's conversation persists under one session, like `xmpp:default`. */
export function peerSessionId(from: string): string {
  return `peer:${sanitizePeerName(from)}`
}

/**
 * Wraps an inbound peer message so the receiving model knows it is talking to
 * another agent, and that its reply travels back automatically — the rule that
 * keeps two instances from ping-ponging peer_message calls at each other.
 */
export function formatInboundPeerMessage(from: string, message: string): string {
  return [
    `[agent-to-agent] Message from peer "${from}", another egirl agent. ` +
      'Your reply text is returned to it directly — do not call peer_message to answer this ' +
      '(only to involve a different peer). Be direct and information-dense; skip pleasantries.',
    '',
    message,
  ].join('\n')
}
