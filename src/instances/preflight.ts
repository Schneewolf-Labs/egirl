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
  /** `skip`: not run because something it depends on is already down; the message says what. */
  level: 'ok' | 'warn' | 'fail' | 'skip'
  message: string
}

const TIMEOUT_MS = 5000

export async function reachable(
  url: string,
  path: string,
  timeoutMs = TIMEOUT_MS,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; detail: string }> {
  try {
    const target = new URL(path, url)
    const response = await fetch(target, { headers, signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
      ? { ok: true, detail: url }
      : { ok: false, detail: `${url} returned HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, detail: `${url}: ${errorMessage(error)}` }
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
    const response = await fetch(url, {
      headers: config.local.apiKey ? { Authorization: `Bearer ${config.local.apiKey}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      return { label: 'served model', level: 'fail', message: `HTTP ${response.status}` }
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }> }

    // A hosted API lists its whole catalogue rather than the one model it loaded, so the
    // question is whether the configured model is offered at all.
    if (config.local.isHosted) {
      const isOffered = body.data?.some((m) => m.id === config.local.model) ?? false
      return {
        label: 'served model',
        level: isOffered ? 'ok' : 'fail',
        message: isOffered
          ? config.local.model
          : `${config.local.model} is not offered by ${config.local.endpoint}`,
      }
    }

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

export async function checkAuxiliary(
  config: RuntimeConfig,
  timeoutMs = TIMEOUT_MS,
): Promise<CheckResult | undefined> {
  const auxiliary = config.local.auxiliary
  if (!auxiliary) return undefined

  const result = await reachable(auxiliary.endpoint, '/v1/models', timeoutMs)
  return {
    label: 'auxiliary model',
    level: result.ok ? 'ok' : 'fail',
    message: result.ok ? `${auxiliary.model} @ ${auxiliary.endpoint}` : result.detail,
  }
}

export async function checkEmbeddings(
  config: RuntimeConfig,
  timeoutMs = TIMEOUT_MS,
): Promise<CheckResult | undefined> {
  const embeddings = config.local.embeddings
  if (!embeddings) return undefined

  const result = await reachable(embeddings.endpoint, '/health', timeoutMs)
  return {
    label: 'embeddings',
    level: result.ok ? 'ok' : 'fail',
    message: result.ok
      ? `${embeddings.model} @ ${embeddings.endpoint}`
      : `${result.detail} (memory falls back to keyword search; memories saved meanwhile are never embedded)`,
  }
}

/**
 * Only URL-backed MCP servers are probed. A stdio server is a command that gets spawned per
 * session; checking it would mean running it, which is a side effect doctor has no business
 * causing.
 */
export async function checkMcpServers(
  config: RuntimeConfig,
  timeoutMs = TIMEOUT_MS,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const server of config.mcp?.servers ?? []) {
    results.push(await checkMcpServer(server, timeoutMs))
  }
  return results
}

type McpServer = NonNullable<RuntimeConfig['mcp']>['servers'][number]

export async function checkMcpServer(
  server: McpServer,
  timeoutMs = TIMEOUT_MS,
): Promise<CheckResult> {
  const label = `mcp ${server.name}`
  if (!server.url) return { label, level: 'ok', message: 'stdio (not probed)' }

  // A bare GET on an MCP endpoint is not a valid session, so most 4xx answers still prove
  // something is listening and routing. 401/403 are the exception: sent with the configured
  // headers, they mean the credential is wrong, and the agent will start without the tools.
  try {
    const res = await fetch(server.url, {
      ...(server.headers && { headers: server.headers }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 401 || res.status === 403) {
      return {
        label,
        level: 'fail',
        message: `${server.url}: HTTP ${res.status} -- check the Authorization header`,
      }
    }
    return { label, level: 'ok', message: server.url }
  } catch (error) {
    return { label, level: 'fail', message: `${server.url}: ${errorMessage(error)}` }
  }
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

/**
 * Every dependency check. Each service is probed on its own port whatever the others answer: a
 * dead operator says nothing about the auxiliary or the embeddings service, and skipping them
 * hid exactly the second outage. Only the served-model check asks the operator endpoint itself,
 * so only it is skipped when that endpoint is already known to be down -- and it says so.
 */
export async function runPreflight(
  config: RuntimeConfig,
  opts: { isOperatorUp?: boolean } = {},
): Promise<CheckResult[]> {
  const isOperatorUp = opts.isOperatorUp ?? true
  const results: CheckResult[] = []
  // Side work on Claude has no served model to compare against the config.
  if (!config.local.isClaude) {
    results.push(
      isOperatorUp
        ? await checkServedModel(config)
        : {
            label: 'served model',
            level: 'skip',
            message: `skipped: ${config.local.endpoint} is unreachable`,
          },
    )
  }

  for (const check of [checkAuxiliary, checkEmbeddings, checkApiPort]) {
    const result = await check(config)
    if (result) results.push(result)
  }

  results.push(...(await checkMcpServers(config)))
  return results
}
