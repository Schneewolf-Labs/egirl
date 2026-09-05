import type { RuntimeConfig } from '../config'
import { errorMessage } from '../util/errors'
import { isPortFree } from './scaffold'

/**
 * The dependency checks an instance needs before it will actually work.
 *
 * `doctor` already proved the operator endpoint answers. That is the smallest part of the graph:
 * an instance also leans on an auxiliary model, an embeddings service, whatever MCP servers are
 * configured, and a free API port. Each of those fails differently and none of them fail at
 * startup -- a missing embeddings service surfaces as memory silently not working, a taken API
 * port as the second instance dying minutes later.
 */

export interface CheckResult {
  label: string
  level: 'ok' | 'warn' | 'fail'
  message: string
}

const TIMEOUT_MS = 5000

async function reachable(url: string, path: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const target = new URL(path, url)
    const response = await fetch(target, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    return response.ok
      ? { ok: true, detail: url }
      : { ok: false, detail: `${url} returned HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, detail: errorMessage(error) }
  }
}

/**
 * What the operator endpoint is actually serving.
 *
 * The config's `model` is a nickname the server never sees, so it can drift from the weights on
 * the other end without anything complaining -- which is how a benchmark ends up attributed to
 * the wrong model. Reported always; only flagged when the two share no recognisable token, since
 * a strict comparison between a nickname and a GGUF filename would cry wolf constantly.
 */
export async function checkServedModel(config: RuntimeConfig): Promise<CheckResult> {
  try {
    const url = new URL('/v1/models', config.local.endpoint)
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) {
      return { label: 'served model', level: 'fail', message: `HTTP ${response.status}` }
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }> }
    const served = body.data?.[0]?.id
    if (!served) {
      return { label: 'served model', level: 'warn', message: 'endpoint named no model' }
    }

    const basename = served.split('/').pop() ?? served
    return {
      label: 'served model',
      level: sharesToken(config.local.model, basename) ? 'ok' : 'warn',
      message: sharesToken(config.local.model, basename)
        ? basename
        : `serving ${basename}, config says ${config.local.model}`,
    }
  } catch (error) {
    return {
      label: 'served model',
      level: 'fail',
      message: errorMessage(error),
    }
  }
}

/** Loose overlap: any alphanumeric run of 4+ characters the two names have in common. */
function sharesToken(a: string, b: string): boolean {
  const tokens = (value: string): Set<string> =>
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((part) => part.length >= 4),
    )
  const left = tokens(a)
  for (const token of tokens(b)) {
    if (left.has(token)) return true
  }
  return false
}

export async function checkAuxiliary(config: RuntimeConfig): Promise<CheckResult | undefined> {
  const auxiliary = config.local.auxiliary
  if (!auxiliary) return undefined

  const result = await reachable(auxiliary.endpoint, '/v1/models')
  return {
    label: 'auxiliary model',
    level: result.ok ? 'ok' : 'fail',
    message: result.ok ? `${auxiliary.model} @ ${auxiliary.endpoint}` : result.detail,
  }
}

export async function checkEmbeddings(config: RuntimeConfig): Promise<CheckResult | undefined> {
  const embeddings = config.local.embeddings
  if (!embeddings) return undefined

  const result = await reachable(embeddings.endpoint, '/health')
  return {
    label: 'embeddings',
    level: result.ok ? 'ok' : 'fail',
    message: result.ok
      ? `${embeddings.model} @ ${embeddings.endpoint}`
      : `${result.detail} (memory will not work)`,
  }
}

/**
 * Only URL-backed MCP servers are probed. A stdio server is a command that gets spawned per
 * session; checking it would mean running it, which is a side effect doctor has no business
 * causing.
 */
export async function checkMcpServers(config: RuntimeConfig): Promise<CheckResult[]> {
  const servers = config.mcp?.servers ?? []
  const results: CheckResult[] = []

  for (const server of servers) {
    if (!server.url) {
      results.push({ label: `mcp ${server.name}`, level: 'ok', message: 'stdio (not probed)' })
      continue
    }
    // A bare GET on an MCP endpoint is not a valid session, so any HTTP answer -- including 4xx
    // -- proves something is listening and routing. Only a transport failure is a real failure.
    try {
      await fetch(server.url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      results.push({ label: `mcp ${server.name}`, level: 'ok', message: server.url })
    } catch (error) {
      results.push({
        label: `mcp ${server.name}`,
        level: 'fail',
        message: `${server.url}: ${errorMessage(error)}`,
      })
    }
  }

  return results
}

/**
 * A configured API port that is already bound is only a problem if something else owns it, and
 * doctor cannot tell "my own instance is already running" from "a port collision". Reported as a
 * warning either way, with both readings named.
 */
export async function checkApiPort(config: RuntimeConfig): Promise<CheckResult | undefined> {
  const api = config.channels.api
  if (!api) return undefined

  const free = await isPortFree(api.port)
  return {
    label: 'api port',
    level: free ? 'ok' : 'warn',
    message: free
      ? `${api.host}:${api.port} available`
      : `${api.port} already bound (this instance already running, or a collision)`,
  }
}

export async function runPreflight(config: RuntimeConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [await checkServedModel(config)]

  for (const check of [checkAuxiliary, checkEmbeddings, checkApiPort]) {
    const result = await check(config)
    if (result) results.push(result)
  }

  results.push(...(await checkMcpServers(config)))
  return results
}
