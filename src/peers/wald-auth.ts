/**
 * Does Wald prove who sent a message?
 *
 * Wald's authentication is opt-in (`WALD_REQUIRE_AUTH`). When it is on, every MCP request needs
 * a bearer token and a message's sender is the token's owner; when it is off, `from_agent` is
 * whatever the sender typed, and anyone on the network can send as a pinned peer. So the
 * mailbox acts on requests only when Wald is seen to refuse an unauthenticated request.
 *
 * The signal is the server's behaviour, not our config: a token in `headers` proves we have
 * one, not that Wald checks anyone's. The probe sends none, and asks again on every poll, so a
 * hub that turns auth off is noticed within one schedule.
 */

import { errorMessage } from '../util/errors'

export type WaldAuthState = 'on' | 'off' | 'unknown'

export interface WaldAuthProbe {
  state: WaldAuthState
  detail: string
}

/** The registry's [[mcp.servers]] entry. Only streamable HTTP can be probed. */
export interface WaldServer {
  url?: string
  command?: string
  headers?: Record<string, string>
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'egirl-auth-probe', version: '1' },
  },
})

export async function probeWaldAuth(
  server: WaldServer | undefined,
  timeoutMs = 5_000,
): Promise<WaldAuthProbe> {
  if (!server?.url) {
    return {
      state: 'unknown',
      detail:
        'the registry is not a streamable-HTTP MCP server, so its authentication cannot be checked',
    }
  }
  try {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: INITIALIZE,
      signal: AbortSignal.timeout(timeoutMs),
    })
    await res.body?.cancel()
    if (res.status === 401 || res.status === 403) {
      return { state: 'on', detail: `Wald refused an unauthenticated request (HTTP ${res.status})` }
    }
    if (res.ok) {
      return { state: 'off', detail: 'Wald answered an unauthenticated request' }
    }
    return { state: 'unknown', detail: `unexpected HTTP ${res.status} from ${server.url}` }
  } catch (error) {
    return { state: 'unknown', detail: `could not reach ${server.url}: ${errorMessage(error)}` }
  }
}
