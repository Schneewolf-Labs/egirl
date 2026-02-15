import { log } from '../util/logger'

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
