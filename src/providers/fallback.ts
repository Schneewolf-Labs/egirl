import { trace } from '../tracking/traces'
import { log } from '../util/logger'
import type { ChatRequest, ChatResponse, LLMProvider } from './types'
import { isConnectionError } from './witchgrid'

/** How long a down auxiliary is left alone before the next request tries it again. */
export const AUX_REPROBE_INTERVAL_MS = 60_000

// Failures to reach the server at all, by message: Bun's fetch, Node's, DNS, and timeouts. A 4xx
// or a malformed answer means the server is there and said no, and is not in this list.
const UNREACHABLE_PATTERNS = [
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /EHOSTUNREACH/,
  /ENETUNREACH/,
  /ENOTFOUND/,
  /EAI_AGAIN/,
  /Unable to connect/i,
  /fetch failed/i,
  /timed out/i,
  /\btimeout\b/i,
]

// llamacpp.ts throws `llama.cpp error: <status> - <body>` for a non-OK response.
const HTTP_5XX = /\berror: 5\d\d\b/
const HTTP_4XX = /\berror: 4\d\d\b/

/** The auxiliary could not serve the request at all: down, unresolvable, timed out, or 5xx. */
export function isAuxUnreachable(error: unknown): boolean {
  if (isConnectionError(error)) return true
  if (!(error instanceof Error)) return false
  if (error.name === 'TimeoutError') return true
  const message = error.message
  // The server answered; whatever the body says (a 408 "timeout", say), it is reachable.
  if (HTTP_4XX.test(message)) return false
  return HTTP_5XX.test(message) || UNREACHABLE_PATTERNS.some((p) => p.test(message))
}

/**
 * The auxiliary model, falling back to the operator model when the auxiliary cannot be reached.
 *
 * Side work (compaction summaries, memory and lesson extraction, self-review) used to fail
 * outright when `[local.auxiliary]` pointed at a server that was not running: every summary fell
 * back to a crude extraction and every memory flush returned nothing, each behind a warn line
 * repeated on every compaction. The operator model can do that work; it is slower to share, but
 * it is up. So the same request goes to the operator, the first fallback is announced once, and
 * the auxiliary is retried every AUX_REPROBE_INTERVAL_MS so it takes the work back when it returns.
 */
export function createAuxFallbackProvider(args: {
  auxiliary: LLMProvider
  operator: LLMProvider
  /** Where the auxiliary lives, for the message that tells the user what to fix. */
  endpoint: string
  /** Injected for tests; defaults to Date.now. */
  now?: () => number
}): LLMProvider {
  const { auxiliary, operator, endpoint } = args
  const now = args.now ?? Date.now
  /** When the auxiliary was last tried and found down; undefined while it is healthy. */
  let downSince: number | undefined
  let lastTry = 0

  const markDown = (error: unknown): void => {
    lastTry = now()
    if (downSince !== undefined) {
      log.debug('aux-fallback', `Auxiliary at ${endpoint} still unreachable; using the operator`)
      return
    }
    downSince = lastTry
    const reason = error instanceof Error ? error.message : String(error)
    log.warn(
      'aux-fallback',
      `Auxiliary model at ${endpoint} is unreachable (${reason}). Side work (compaction ` +
        'summaries, memory extraction, self-review) is running on the operator model instead. ' +
        'Start the auxiliary server, or remove [local.auxiliary] from egirl.toml. It will be ' +
        `retried every ${AUX_REPROBE_INTERVAL_MS / 1000}s.`,
    )
    trace({
      kind: 'aux',
      name: 'aux_fallback',
      success: false,
      payload: { endpoint, error: reason, fallback: operator.name },
    })
  }

  const markUp = (): void => {
    if (downSince === undefined) return
    const downMs = now() - downSince
    downSince = undefined
    log.info(
      'aux-fallback',
      `Auxiliary model at ${endpoint} is answering again after ${Math.round(downMs / 1000)}s; side work is back on it`,
    )
    trace({ kind: 'aux', name: 'aux_recovered', success: true, payload: { endpoint, downMs } })
  }

  return {
    name: auxiliary.name,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      if (downSince !== undefined && now() - lastTry < AUX_REPROBE_INTERVAL_MS) {
        log.debug('aux-fallback', `Auxiliary at ${endpoint} down; side work on the operator`)
        return operator.chat(req)
      }
      // Claim the probe before awaiting it, so concurrent side work does not all probe at once.
      if (downSince !== undefined) lastTry = now()

      let response: ChatResponse
      try {
        response = await auxiliary.chat(req)
      } catch (error) {
        // A caller's abort is not the server's failure, and an answer the server gave (4xx, bad
        // output) would be the same answer from a retry: both propagate as they always did.
        if (req.signal?.aborted) throw error
        if (!isAuxUnreachable(error)) {
          markUp()
          throw error
        }
        markDown(error)
        return operator.chat(req)
      }
      markUp()
      return response
    },
  }
}
