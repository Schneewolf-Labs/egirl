import { log } from '../util/logger'

/**
 * ReplyBroker — the piece that lets a human answer a blocking `report` ask over a normal
 * chat channel.
 *
 * The report tool parks a promise here keyed by (channel, target); when the channel's
 * inbound handler sees the next message from that target it delivers it to the parked ask
 * instead of starting a new agent run. This is what makes a human "just a slow peer": the
 * same send-block-reply contract peer_message gives an agent supervisor, implemented over
 * whatever chat surface the human is already on.
 *
 * Multiple asks on one target queue FIFO — each inbound message answers the oldest waiting
 * ask. A timed-out ask resolves undefined so the agent can decide to park or push on.
 */
export class ReplyBroker {
  private pending = new Map<
    string,
    Array<{ resolve: (reply: string | undefined) => void; timer: ReturnType<typeof setTimeout> }>
  >()

  private key(channel: string, target: string): string {
    return `${channel}:${target.toLowerCase()}`
  }

  /** Park until the next inbound message from (channel, target), or undefined on timeout. */
  awaitReply(channel: string, target: string, timeoutMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const key = this.key(channel, target)
      const queue = this.pending.get(key) ?? []
      const entry = {
        resolve,
        timer: setTimeout(() => {
          const q = this.pending.get(key)
          if (q) {
            const i = q.indexOf(entry)
            if (i >= 0) q.splice(i, 1)
            if (q.length === 0) this.pending.delete(key)
          }
          resolve(undefined)
        }, timeoutMs),
      }
      queue.push(entry)
      this.pending.set(key, queue)
    })
  }

  /**
   * Offer an inbound message to the oldest ask waiting on (channel, target).
   * Returns true when consumed — the channel should NOT dispatch it to the agent.
   */
  tryDeliver(channel: string, target: string, message: string): boolean {
    const key = this.key(channel, target)
    const queue = this.pending.get(key)
    const entry = queue?.shift()
    if (!entry) return false
    if (queue && queue.length === 0) this.pending.delete(key)
    clearTimeout(entry.timer)
    entry.resolve(message)
    log.info('report', `Inbound message from ${key} delivered to a pending ask`)
    return true
  }

  hasPending(channel: string, target: string): boolean {
    return (this.pending.get(this.key(channel, target))?.length ?? 0) > 0
  }
}

export function createReplyBroker(): ReplyBroker {
  return new ReplyBroker()
}
