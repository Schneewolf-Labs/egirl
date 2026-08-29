import { log } from '../util/logger'

/**
 * Ask the local endpoint what context size it actually serves. llama.cpp reports the
 * per-slot window as `default_generation_settings.n_ctx` from /props; an endpoint with no
 * /props (vLLM, OpenAI-compat proxies) answers 404 and the probe returns undefined.
 *
 * The server's n_ctx is a hard limit: a prompt one token over it is rejected outright, so a
 * configured context_length above it is a promise the server will not honor. The caller
 * clamps config to this value (see bootstrap).
 */
export async function probeServerContextLength(
  endpoint: string,
  apiKey?: string,
): Promise<number | undefined> {
  const base = endpoint.replace(/\/+$/, '').replace(/\/v1$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(`${base}/props`, {
      signal: controller.signal,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    })
    if (!res.ok) return undefined
    const props = (await res.json()) as { default_generation_settings?: { n_ctx?: number } }
    const nCtx = props.default_generation_settings?.n_ctx
    return typeof nCtx === 'number' && nCtx > 0 ? nCtx : undefined
  } catch (err) {
    log.debug('context-probe', `Could not probe ${base}/props: ${err}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
