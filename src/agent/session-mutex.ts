import { log } from '../util/logger'

export class MutexTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent run timed out after ${timeoutMs}ms while holding the session mutex`)
    this.name = 'MutexTimeoutError'
  }
}

/**
 * Async mutex that serializes agent runs across all entry points.
 *
 * Without this, Discord messages, CLI input, and background tasks can
 * trigger concurrent agent.run() calls that race on shared workspace
 * state and the tool executor. This mutex ensures only one agent run
 * is active at a time — queuing others until the current one completes.
 *
 * Inspired by OpenClaw's Lane Queue concept, simplified for single-user.
 */
export class SessionMutex {
  private queue: Array<() => void> = []
  private locked = false
  private runTimeoutMs: number | undefined

  /**
   * @param runTimeoutMs — optional hard timeout for `run()`. If the function
   *   doesn't complete within this window, the lock is released and a
   *   MutexTimeoutError is thrown so subsequent runs aren't blocked forever.
   */
  constructor(runTimeoutMs?: number) {
    this.runTimeoutMs = runTimeoutMs
  }

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }

    log.debug('mutex', `Agent run queued (${this.queue.length + 1} waiting)`)

    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.locked = false
    }
  }

  /**
   * Run a function with exclusive access. Queues if another run is active.
   *
   * @param fn — the async function to run while holding the lock
   * @param timeoutMs — per-call timeout override (falls back to constructor default)
   */
  async run<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    await this.acquire()
    const deadline = timeoutMs ?? this.runTimeoutMs

    if (!deadline) {
      try {
        return await fn()
      } finally {
        this.release()
      }
    }

    try {
      return await this.withTimeout(fn, deadline)
    } finally {
      this.release()
    }
  }

  /** Race the function against a timeout. Throws MutexTimeoutError on expiry. */
  private withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        log.error('mutex', `Agent run exceeded ${timeoutMs}ms timeout — releasing lock`)
        reject(new MutexTimeoutError(timeoutMs))
      }, timeoutMs)
      timer.unref()

      fn().then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  isLocked(): boolean {
    return this.locked
  }

  get pending(): number {
    return this.queue.length
  }
}
