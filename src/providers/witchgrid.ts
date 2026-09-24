import { log } from '../util/logger'

/**
 * Locate the operator's llama-server through a Witchgrid control plane.
 *
 * Witchgrid answers `GET /resolve/{profile}` with the live server's `base_url`, and egirl then
 * talks to that server directly. Its other route, `/v1/llama/{profile}/*`, would also work and
 * auto-spawns the model, but the CP fans out to every agent on each request, which is the wrong
 * cost for the /tokenize and /v1/chat/completions calls egirl makes all the time. So the proxy
 * is only the fallback for "nothing is running yet": the first request through it has Witchgrid
 * spawn the model, and `api_key` is then the CP's bearer (the proxy does not forward it).
 */

export interface WitchgridTarget {
  /** Control plane base URL, e.g. http://witchgrid.lan:8765 */
  url: string
  /** Profile or alias to resolve. */
  profile: string
}

export type WitchgridResolution =
  | { kind: 'direct'; baseUrl: string }
  | { kind: 'proxy'; baseUrl: string }

/** Function a provider calls to find where its endpoint went. Undefined means "no better idea". */
export type EndpointReresolver = () => Promise<string | undefined>

const RESOLVE_TIMEOUT_MS = 5_000

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Throws when the control plane cannot be reached or answers something other than 200/404. */
export async function resolveWitchgrid(target: WitchgridTarget): Promise<WitchgridResolution> {
  const cp = trimSlash(target.url)
  const profile = encodeURIComponent(target.profile)
  const res = await fetch(`${cp}/resolve/${profile}`, {
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
  })
  if (res.status === 404) return { kind: 'proxy', baseUrl: `${cp}/v1/llama/${profile}` }
  if (!res.ok) throw new Error(`${cp}/resolve/${profile} returned HTTP ${res.status}`)
  const body = (await res.json()) as { base_url?: unknown }
  if (typeof body.base_url !== 'string' || body.base_url === '') {
    throw new Error(`${cp}/resolve/${profile} answered without a base_url`)
  }
  return { kind: 'direct', baseUrl: trimSlash(body.base_url) }
}

/**
 * Startup resolution. An unreachable CP falls back to an explicitly configured `endpoint` when
 * there is one — the operator named that address on purpose, and a control plane being down
 * should not stop an agent whose model may well still be up. With no explicit endpoint there is
 * nothing sensible to guess (the default localhost:8080 is almost certainly wrong in a fleet
 * setup), so startup fails with the reason.
 */
export async function resolveOperatorEndpoint(
  target: WitchgridTarget,
  fallbackEndpoint?: string,
): Promise<string> {
  try {
    const r = await resolveWitchgrid(target)
    if (r.kind === 'direct') {
      log.info('witchgrid', `Profile '${target.profile}' is live at ${r.baseUrl}`)
    } else {
      log.info(
        'witchgrid',
        `Profile '${target.profile}' is not running; using the auto-spawning proxy ${r.baseUrl}`,
      )
    }
    return r.baseUrl
  } catch (error) {
    const reason = (error as Error).message
    if (fallbackEndpoint) {
      log.warn(
        'witchgrid',
        `Could not resolve '${target.profile}' via ${target.url} (${reason}); using configured endpoint ${fallbackEndpoint}`,
      )
      return fallbackEndpoint
    }
    throw new Error(
      `[local.witchgrid] could not resolve profile '${target.profile}' via ${target.url}: ${reason}. ` +
        'Start the Witchgrid control plane, fix the url, or set [local].endpoint as a fallback.',
    )
  }
}

/**
 * Re-resolution for a provider whose direct endpoint stopped answering: the model restarted on
 * another port or moved to another node. Writes the new address into `holder.endpoint` so every
 * reader of the config (the tokenizer included) follows it. Concurrent callers share one lookup.
 */
export function createWitchgridReresolver(
  target: WitchgridTarget,
  holder: { endpoint: string },
): EndpointReresolver {
  let inFlight: Promise<string | undefined> | undefined
  return () => {
    inFlight ??= resolveWitchgrid(target)
      .then((r) => {
        if (r.baseUrl !== holder.endpoint) {
          log.info(
            'witchgrid',
            `Profile '${target.profile}' moved: ${holder.endpoint} -> ${r.baseUrl}`,
          )
          holder.endpoint = r.baseUrl
        }
        return r.baseUrl
      })
      .catch((error) => {
        log.warn(
          'witchgrid',
          `Re-resolving '${target.profile}' failed: ${(error as Error).message}`,
        )
        return undefined
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }
}

const CONNECTION_ERROR_CODES = new Set([
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENOTFOUND',
])

/** A failure to reach the server at all, as opposed to an abort or an HTTP-level error. */
export function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)
}
