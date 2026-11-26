/**
 * `/interrupt [n]`: send queued messages into the turn that is running, now.
 *
 * Typing mid-turn queues, so a correction typed while the agent heads the wrong way waits for
 * the whole turn to finish. This takes the oldest `n` queued messages (all of them without a
 * number) and hands them to the run: on an operator that can take a message mid-run (the
 * local loop, Codex) it is seen at the next model call, after any tool that is running; on
 * one that cannot (Claude), the turn is stopped and they go next, as a turn of their own.
 */

import type { Operator } from '../operator/types'
import type { SessionController } from '../session/controller'
import { colors, DIM, RESET } from '../ui/theme'

export function interruptCommand(
  arg: string,
  deps: { agent: Operator; session: SessionController },
): string {
  const c = colors()
  const word = arg.trim()
  const n = word ? Number(word) : undefined
  if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
    return `${c.warning}/interrupt takes a count:${RESET} ${DIM}/interrupt 2 sends the oldest two queued messages${RESET}`
  }
  const { agent, session } = deps
  if (!session.isRunning) {
    return `${DIM}Nothing is running — just send it.${RESET}`
  }
  const taken = session.take(n)
  if (!taken) {
    return `${DIM}Nothing queued. Type the message first (it queues), then /interrupt; esc stops the turn.${RESET}`
  }
  const what = taken.count === 1 ? '1 queued message' : `${taken.count} queued messages`
  const left = session.peek().length
  const rest = left > 0 ? ` · ${left} still queued` : ''
  if (agent.inject(taken.text)) {
    return `${c.secondary}↪${RESET} ${c.primary}sent ${what} into this turn${RESET} ${DIM}— seen at the next step${rest}${RESET}`
  }
  session.sendNext(taken.text)
  session.interrupt()
  return `${c.warning}interrupting…${RESET} ${DIM}this operator can't take a message mid-turn, so ${what} go next${rest}${RESET}`
}
