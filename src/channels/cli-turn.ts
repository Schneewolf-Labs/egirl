/**
 * One agent run in the terminal, and what follows it: the reply, the context bar, and the
 * next step to offer.
 */

import { windowFill } from '../agent/status'
import type { Operator } from '../operator/types'
import { CONTINUE_PROMPT } from '../session/commands'
import type { SessionController } from '../session/controller'
import { colors, DIM, RESET } from '../ui/theme'
import { errorMessage } from '../util/errors'
import { log } from '../util/logger'
import { createCLIEventHandler, printReply, renderDrained, renderTurnCap } from './cli-events'
import type { CLIInput } from './cli-input'
import { createRunStats, withStats } from './cli-stats'
import { contextBar, createStatusLine } from './cli-status'

export interface TurnDeps {
  agent: Operator
  session: SessionController
  input: CLIInput | undefined
  showThinking: boolean
}

/** Window fill past which the empty prompt offers `/compact`. Matches the bar's red band. */
const COMPACT_HINT_FILL = 0.8

/** Run `first`, then everything queued or continued after it, until nothing is pending. */
export async function runTurns(first: string, deps: TurnDeps): Promise<void> {
  const { session, input } = deps
  // The window size for the stats' context figure. Fetched alongside the first run rather
  // than before it: on a large history the count is not free, and the run should not wait.
  const window: { length?: number } = {}
  deps.agent
    .contextStatus()
    .then((s) => {
      window.length ??= s.contextLength
    })
    .catch(() => {})
  let pending: string | undefined = first
  while (pending !== undefined) {
    const hitCap = await runOne(pending, deps, window)
    const ctx = await printContext(deps.agent)
    if (ctx) window.length = ctx.contextLength
    const fill = ctx?.fraction

    // Anything typed during the turn runs now rather than waiting for another return --
    // a queued message that sits unseen is worse than one that was never accepted.
    const queued = session.peek().length
    pending = session.drain()
    if (pending) {
      console.log(renderDrained(pending, queued))
      continue
    }
    // Something typed meanwhile takes precedence over carrying on: it may be the redirect.
    // The cap notice itself says when /auto is continuing, so no echo follows it.
    if (hitCap) {
      const isContinuing = session.shouldContinuePastCap()
      console.log(renderTurnCap(session.get().maxTurns, isContinuing))
      if (isContinuing) pending = CONTINUE_PROMPT
      else input?.suggest('/continue')
    } else if (fill !== undefined && fill >= COMPACT_HINT_FILL) {
      input?.suggest('/compact')
    }
  }
}

/** One run. True when the turn cap, not the model, ended it. */
async function runOne(text: string, deps: TurnDeps, window: { length?: number }): Promise<boolean> {
  const c = colors()
  const { session, input } = deps
  const signal = session.begin()
  const maxTurns = session.get().maxTurns
  const stats = createRunStats({
    maxTurns,
    contextLength: () => window.length,
    queued: () => session.peek().length,
    isEnabled: () => session.get().showStats,
  })
  // 'waiting' rather than 'thinking': nothing has come back yet, so this is prefill, which on
  // a large context is minutes of genuine silence before the model even starts reasoning.
  // Calling that "thinking" would be a guess presented as fact.
  const status = createStatusLine({
    ...(input?.isInteractive && { sink: (t: string) => input.setStatus(t) }),
    extra: () => stats.render(),
  })
  status.set('waiting')
  try {
    console.log()
    const { handler, state } = createCLIEventHandler(deps.showThinking, status)
    const response = await deps.agent.run(text, {
      events: withStats(handler, stats),
      maxTurns,
      signal,
    })
    log.debug('cli', `[${response.provider}]`)
    if (session.wasInterrupted) {
      console.log(`\n${c.warning}stopped.${RESET}\n`)
      return false
    }
    printReply(state, response.content)
    return response.turnLimitReached === true
  } catch (error) {
    console.error(`\n${c.error}Error:${RESET} ${errorMessage(error)}\n`)
    return false
  } finally {
    status.stop()
    session.end()
  }
}

/**
 * Printed every turn rather than on demand, because the moment context pressure matters --
 * the turn before compaction discards the middle of the conversation -- is exactly the moment
 * nobody thinks to type /context. Returns the window fill, undefined when it is unknown.
 */
async function printContext(
  agent: Operator,
): Promise<{ fraction: number; contextLength: number } | undefined> {
  try {
    const ctx = await agent.contextStatus()
    const fill = windowFill(ctx)
    const history = fill.isMeasured ? ctx.totalUsed : undefined
    console.log(
      `${DIM}context${RESET} ${contextBar(fill.fraction, fill.used, ctx.contextLength, history)}\n`,
    )
    return { fraction: fill.fraction, contextLength: ctx.contextLength }
  } catch {
    // A status readout must never break a turn that already succeeded.
    return undefined
  }
}
