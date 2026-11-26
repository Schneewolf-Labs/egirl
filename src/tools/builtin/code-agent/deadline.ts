/**
 * When a code-agent run is stopped: a wall-clock cap, and a stall cap.
 *
 * One fixed deadline cannot tell a long run that is working from one that is stuck. Five
 * minutes cut off real work (two test suites, a large refactor) mid-stride, and a cap long
 * enough for that work waits just as long on an agent hung on a prompt nobody will answer.
 * So the total is generous, and a second, shorter clock starts over each time the agent does
 * something: no activity at all for `idleMs` means it is stuck, whatever the total says.
 */

export interface DeadlineLimits {
  totalMs: number
  /** No activity for this long stops the run; 0 turns the stall check off. */
  idleMs: number
}

export interface RunDeadline {
  /** The agent did something: the stall clock starts over. */
  touch(): void
  clear(): void
  /** Why the run was stopped, once it has been. */
  readonly expired: 'total' | 'idle' | undefined
  /** How long the run had gone when it was stopped. */
  readonly elapsedMs: number
}

export function startDeadline(limits: DeadlineLimits, onExpire: () => void): RunDeadline {
  const started = Date.now()
  let expired: 'total' | 'idle' | undefined
  let stoppedAt = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const expire = (why: 'total' | 'idle'): void => {
    if (expired) return
    expired = why
    stoppedAt = Date.now()
    clearTimeout(totalTimer)
    clearTimeout(idleTimer)
    onExpire()
  }
  const totalTimer = setTimeout(() => expire('total'), limits.totalMs)
  const armIdle = (): void => {
    clearTimeout(idleTimer)
    // A stall cap at or past the total could never fire first.
    if (limits.idleMs > 0 && limits.idleMs < limits.totalMs) {
      idleTimer = setTimeout(() => expire('idle'), limits.idleMs)
    }
  }
  armIdle()

  return {
    touch(): void {
      if (!expired) armIdle()
    },
    clear(): void {
      clearTimeout(totalTimer)
      clearTimeout(idleTimer)
    },
    get expired() {
      return expired
    },
    get elapsedMs() {
      return (expired ? stoppedAt : Date.now()) - started
    },
  }
}

/** The run's limits from config, with the defaults. */
export function deadlineLimits(config: {
  timeoutMs?: number
  idleTimeoutMs?: number
}): DeadlineLimits {
  return {
    totalMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    idleMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
  }
}

/** Total cap: 30 minutes. Long enough for a build and two test suites. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Stall cap: 10 minutes with nothing from the agent. Claude Code's own shell commands stop at
 * 10 minutes, so an agent that is working says something well inside this.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000

/** What the timeout report says about why the run stopped. */
export function stopReason(deadline: RunDeadline, limits: DeadlineLimits): string {
  return deadline.expired === 'idle'
    ? `It had stalled: nothing from the agent for ${secs(limits.idleMs)}.`
    : `It hit the ${secs(limits.totalMs)} limit while still working.`
}

export function secs(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`
}
