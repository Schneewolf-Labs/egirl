import { log } from '../util/logger'

/**
 * Locate the operator's llama-server through a Witchgrid control plane.
 *
 * Witchgrid answers `GET /resolve/{profile}` with the live server's `base_url`, and egirl then
 * talks to that server directly. Its other route, `/v1/llama/{profile}/*`, would also work and
 * auto-spawns the model, but the CP fans out to every agent on each request, which is the wrong
 * cost for the /tokenize and /v1/chat/completions calls egirl makes all the time. So the proxy
 * is only the fallback for "nothing is running yet": the first request through it has Witchgrid
 * spawn the model, and `api_key` is then the CP's bearer (the proxy does not forward it). Once the
 * model is up, egirl moves off the proxy on its own (createWitchgridPromoter).
 */

export interface WitchgridTarget {
  /** Control plane base URL, e.g. http://witchgrid.lan:8765 */
  url: string
  /** Profile or alias to resolve. */
  profile: string
  /** WITCHGRID_SHARED_SECRET, for a CP that gates its read surface (WITCHGRID_AUTH_PROTECT_READ). */
  token?: string
}

export type WitchgridResolution =
  | { kind: 'direct'; baseUrl: string }
  | { kind: 'proxy'; baseUrl: string }

/** Function a provider calls to find where its endpoint went. Undefined means "no better idea". */
export type EndpointReresolver = () => Promise<string | undefined>

const RESOLVE_TIMEOUT_MS = 5_000
/** How often, at most, a request on the proxy checks whether the profile now runs directly. */
const PROMOTE_INTERVAL_MS = 30_000

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function proxyUrl(target: WitchgridTarget): string {
  return `${trimSlash(target.url)}/v1/llama/${encodeURIComponent(target.profile)}`
}

/** GET a read-surface route of the CP, with the bearer when there is one. */
async function cpGet(target: WitchgridTarget, path: string): Promise<Response> {
  const url = `${trimSlash(target.url)}${path}`
  const res = await fetch(url, {
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    ...(target.token && { headers: { Authorization: `Bearer ${target.token}` } }),
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `${url} returned HTTP ${res.status}: the CP gates reads (WITCHGRID_AUTH_PROTECT_READ); ` +
        'set WITCHGRID_SHARED_SECRET to its shared secret',
    )
  }
  return res
}

/**
 * Throws when the control plane cannot be reached, refuses the bearer, does not know the profile,
 * or answers something other than 200/404. /resolve 404s both for "not running" and for a name
 * that does not exist, so a 404 is followed by a profile lookup: a typo must not quietly become
 * a proxy URL that only fails at the first chat request.
 */
export async function resolveWitchgrid(target: WitchgridTarget): Promise<WitchgridResolution> {
  const profile = encodeURIComponent(target.profile)
  const res = await cpGet(target, `/resolve/${profile}`)
  if (res.status === 404) {
    // The 404 names the profile an alias resolved to; profiles are looked up by that name.
    const body = (await res.json().catch(() => ({}))) as { profile?: unknown }
    const name = typeof body.profile === 'string' && body.profile ? body.profile : target.profile
    const known = await cpGet(target, `/api/profiles/${encodeURIComponent(name)}`)
    if (known.status === 404) {
      throw new Error(`no profile named '${target.profile}' on ${trimSlash(target.url)}`)
    }
    return { kind: 'proxy', baseUrl: proxyUrl(target) }
  }
  if (!res.ok) throw new Error(`${res.url} returned HTTP ${res.status}`)
  const body = (await res.json()) as { base_url?: unknown }
  if (typeof body.base_url !== 'string' || body.base_url === '') {
    throw new Error(`${res.url} answered without a base_url`)
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

/**
 * While the endpoint is Witchgrid's proxy (the profile was not running when egirl looked), check
 * again before a request, at most once per interval, and move to the direct address as soon as
 * the profile is live. Nothing else would ever move egirl off the proxy: it never refuses a
 * connection, so the reresolver above never fires, and every request would keep paying the CP's
 * fan-out. Checking on the next request rather than on a timer means an idle agent makes no calls,
 * and the check is one cheap GET. Returns the new address, or undefined to stay put.
 */
export function createWitchgridPromoter(
  target: WitchgridTarget,
  holder: { endpoint: string },
  intervalMs = PROMOTE_INTERVAL_MS,
): EndpointReresolver {
  const proxy = proxyUrl(target)
  let lastCheck = 0
  let inFlight: Promise<string | undefined> | undefined
  return async () => {
    if (holder.endpoint !== proxy) return undefined
    if (inFlight) return inFlight
    if (lastCheck && Date.now() - lastCheck < intervalMs) return undefined
    lastCheck = Date.now()
    inFlight = resolveWitchgrid(target)
      .then((r) => {
        if (r.kind !== 'direct') return undefined
        log.info(
          'witchgrid',
          `Profile '${target.profile}' is up; leaving the proxy for ${r.baseUrl}`,
        )
        holder.endpoint = r.baseUrl
        return r.baseUrl
      })
      .catch((error) => {
        log.warn('witchgrid', `Checking '${target.profile}' failed: ${(error as Error).message}`)
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
