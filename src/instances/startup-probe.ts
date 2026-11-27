import type { RuntimeConfig } from '../config'
import { log } from '../util/logger'
import {
  type CheckResult,
  checkAuxiliary,
  checkEmbeddings,
  checkMcpServer,
  reachable,
} from './preflight'

/**
 * One line per configured dependency when a long-running instance starts.
 *
 * Without it a dead dependency was found only by running `doctor`, or by noticing the symptom:
 * memory quietly recalling less, side work erroring, an MCP server's tools simply absent. These
 * are the same probes doctor runs, given a short timeout and run side by side, so a down service
 * is named before the first turn. Down is a warning (visible at the default level); up is debug,
 * since a healthy dependency is routine. Unconfigured services print nothing.
 *
 * Nothing here can stop startup: every probe is bounded by its own timer on top of its fetch
 * timeout, and a probe that throws counts as down.
 */

export const STARTUP_PROBE_TIMEOUT_MS = 2000

export interface DependencyProbe {
  name: string
  target: string
  /** What the instance does without it -- the half of the line that matters. */
  ifDown: string
  probe: (timeoutMs: number) => Promise<CheckResult | undefined>
}

/** The dependencies this config actually names. */
export function dependencyProbes(config: RuntimeConfig): DependencyProbe[] {
  const probes: DependencyProbe[] = []
  const { local } = config

  // With side work on Claude, the [local] endpoint is never called.
  if (!local.isClaude) {
    const isOperator = (config.operator?.provider ?? 'local') === 'local'
    const headers: Record<string, string> = local.apiKey
      ? { Authorization: `Bearer ${local.apiKey}` }
      : {}
    probes.push({
      name: isOperator ? 'operator' : 'local model',
      target: local.endpoint,
      ifDown: isOperator ? 'turns will fail until it answers' : 'side work will fail',
      probe: async (timeoutMs) => {
        const result = await reachable(local.endpoint, '/v1/models', timeoutMs, headers)
        return { label: 'operator', level: result.ok ? 'ok' : 'fail', message: result.detail }
      },
    })
  }

  if (local.auxiliary) {
    probes.push({
      name: 'auxiliary',
      target: local.auxiliary.endpoint,
      ifDown: 'side work will run on the operator',
      probe: (timeoutMs) => checkAuxiliary(config, timeoutMs),
    })
  }

  // Recall and memory_search go through hybrid search, which keeps its keyword half when the
  // embedding call fails (src/memory/search.ts). A memory saved meanwhile is stored with no
  // vector, and nothing re-embeds it later; duplicate detection is off too.
  if (local.embeddings) {
    probes.push({
      name: 'embeddings',
      target: local.embeddings.endpoint,
      ifDown: 'memory falls back to keyword search; memories saved meanwhile are never embedded',
      probe: (timeoutMs) => checkEmbeddings(config, timeoutMs),
    })
  }

  // Stdio servers are spawned, not probed. A URL server that fails to connect at startup is
  // dropped for the life of the process (src/mcp/client.ts).
  for (const server of config.mcp?.servers ?? []) {
    if (!server.url) continue
    probes.push({
      name: `mcp ${server.name}`,
      target: server.url,
      ifDown: 'its tools will be missing until restart',
      probe: (timeoutMs) => checkMcpServer(server, timeoutMs),
    })
  }

  return probes
}

type Outcome = { isUp: true } | { isUp: false; detail: string }

async function runBounded(probe: DependencyProbe, timeoutMs: number): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ isUp: false, detail: `no answer within ${timeoutMs}ms` }),
      timeoutMs,
    )
  })
  const answered = probe
    .probe(timeoutMs)
    .then((result): Outcome => {
      if (!result || result.level !== 'fail') return { isUp: true }
      return { isUp: false, detail: result.message }
    })
    .catch((error: unknown): Outcome => ({ isUp: false, detail: String(error) }))
  try {
    return await Promise.race([answered, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Probe every configured dependency in parallel and log one line each. Never throws. */
export async function reportDependencies(
  config: RuntimeConfig,
  opts: { probes?: DependencyProbe[]; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? STARTUP_PROBE_TIMEOUT_MS
  let probes: DependencyProbe[]
  try {
    probes = opts.probes ?? dependencyProbes(config)
  } catch (error) {
    log.warn('deps', 'Could not list dependencies to probe:', error)
    return
  }

  const outcomes = await Promise.all(probes.map((probe) => runBounded(probe, timeoutMs)))
  probes.forEach((probe, i) => {
    const outcome = outcomes[i]
    if (!outcome) return
    if (outcome.isUp) {
      log.debug('deps', `${probe.name} ${probe.target} up`)
      return
    }
    log.warn('deps', `${probe.name} ${probe.target} down: ${probe.ifDown}`)
    log.debug('deps', `${probe.name}: ${outcome.detail}`)
  })
}
