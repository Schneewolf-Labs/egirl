import { log } from '../util/logger'

/**
 * Ask the local endpoint whether it can accept image input. llama.cpp reports
 * `modalities: { vision: true }` from /props when launched with --mmproj; a server without
 * the flag says vision: false, and an endpoint with no /props at all (vLLM, OpenAI-compat
 * proxies) answers 404. Anything but an explicit yes is treated as no — offering the
 * screenshot tool to a text-only endpoint produces requests the server 500s wholesale.
 */
export async function probeVisionSupport(endpoint: string, apiKey?: string): Promise<boolean> {
  const base = endpoint.replace(/\/+$/, '').replace(/\/v1$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(`${base}/props`, {
      signal: controller.signal,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    })
    if (!res.ok) return false
    const props = (await res.json()) as { modalities?: { vision?: boolean } }
    return props.modalities?.vision === true
  } catch (err) {
    log.debug('vision-probe', `Could not probe ${base}/props: ${err}`)
    return false
  } finally {
    clearTimeout(timer)
  }
}
