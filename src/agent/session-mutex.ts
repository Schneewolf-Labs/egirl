import { log } from '../util/logger'

/** Default max time a queued run waits for the lock before failing (10 minutes) */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10 * 60 * 1000

interface Waiter {
  resolve: () => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Async mutex that serializes agent runs across all entry points.
 *
 * Without this, Discord messages, CLI input, and background tasks can
 * trigger concurrent agent.run() calls that race on shared workspace
 * state and the tool executor. This mutex ensures only one agent run
 * is active at a time — queuing others until the current one completes.
 *
 * Queued waiters time out after `acquireTimeoutMs` so a single hung run
 * can't deadlock every entry point forever. Pass 0 to disable the timeout.
 *
 * Inspired by OpenClaw's Lane Queue concept, simplified for single-user.
 */
export class SessionMutex {
  private queue: Waiter[] = []
  private locked = false
  private acquireTimeoutMs: number

  constructor(acquireTimeoutMs: number = DEFAULT_ACQUIRE_TIMEOUT_MS) {
    this.acquireTimeoutMs = acquireTimeoutMs
  }

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }

    log.debug('mutex', `Agent run queued (${this.queue.length + 1} waiting)`)

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject }

      if (this.acquireTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.queue.indexOf(waiter)
          if (idx !== -1) this.queue.splice(idx, 1)
          log.warn('mutex', `Queued agent run timed out after ${this.acquireTimeoutMs}ms`)
          reject(
            new Error(
              `Timed out after ${Math.round(this.acquireTimeoutMs / 1000)}s waiting for the current agent run to finish`,
            ),
          )
        }, this.acquireTimeoutMs)
      }

      this.queue.push(waiter)
    })
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      if (next.timer) clearTimeout(next.timer)
      next.resolve()
    } else {
      this.locked = false
    }
  }

  /** Run a function with exclusive access. Queues if another run is active. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  isLocked(): boolean {
    return this.locked
  }

  get pending(): number {
    return this.queue.length
  }
}
