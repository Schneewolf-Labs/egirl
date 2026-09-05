import { log } from '../util/logger'

/** The parts of llama.cpp's GET /props that bootstrap reads. */
export interface ServerProps {
  default_generation_settings?: { n_ctx?: number }
  modalities?: { vision?: boolean }
}

/**
 * Ask the local endpoint what it actually serves. llama.cpp answers /props; an endpoint
 * without it (vLLM, OpenAI-compat proxies) answers 404 and the probe returns undefined, which
 * every reader below treats as "unknown".
 */
export async function probeServerProps(
  endpoint: string,
  apiKey?: string,
): Promise<ServerProps | undefined> {
  const base = endpoint.replace(/\/+$/, '').replace(/\/v1$/, '')
  try {
    const res = await fetch(`${base}/props`, {
      signal: AbortSignal.timeout(3000),
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    })
    if (!res.ok) return undefined
    return (await res.json()) as ServerProps
  } catch (err) {
    log.debug('server-props', `Could not probe ${base}/props: ${err}`)
    return undefined
  }
}

/**
 * The per-slot context window the server enforces. A prompt one token over it is rejected
 * outright, so a configured context_length above it is a promise the server will not honor.
 */
export function serverContextLength(props: ServerProps | undefined): number | undefined {
  const nCtx = props?.default_generation_settings?.n_ctx
  return typeof nCtx === 'number' && nCtx > 0 ? nCtx : undefined
}

/**
 * Whether the server accepts image input (llama.cpp launched with --mmproj). Anything but an
 * explicit yes is no: offering the screenshot tool to a text-only endpoint produces requests
 * the server 500s wholesale.
 */
export function serverSupportsVision(props: ServerProps | undefined): boolean {
  return props?.modalities?.vision === true
}
