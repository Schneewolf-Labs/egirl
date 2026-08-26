/**
 * The console as a report target.
 *
 * `report` already treats a human as a slow peer: send on some outbound channel, park on the
 * ReplyBroker, resume when they answer. That worked for Discord and XMPP and left the console —
 * the surface actually being used — unable to receive an escalation at all. An instance with no
 * chat channel configured had nowhere to put "this one is yours", so the question died in a tool
 * error and the agent went back to guessing.
 *
 * This is an outbound channel whose "send" is simply "hold it where the console can see it".
 * Answering in the browser resolves the same promise a Discord reply would have.
 *
 * Deliberately in memory: an ask only exists while a run is parked on it, and that run does not
 * survive a restart either. Persisting the question would just resurrect a prompt whose asker is
 * already gone.
 */

export interface ConsoleAsk {
  id: string
  /** Who is asking: the instance that raised the escalation. */
  from: string
  /** Report target the answer must be delivered back through. */
  target: string
  question: string
  askedAt: number
  /** 'ask' blocks an agent on your answer; 'notice' is one-way and just wants dismissing. */
  kind: 'ask' | 'notice'
}

export class ConsoleInbox {
  private asks = new Map<string, ConsoleAsk>()
  private seq = 0

  /**
   * @param selfName the instance doing the asking. Every ask in this inbox comes from it, and
   *   labelling a card with the *target* instead would caption it with the name of the person
   *   reading it — "nick is asking you" — which is nonsense.
   */
  constructor(private readonly selfName: string) {}

  /** The outbound half: called by the report tool when the target channel is `console`. */
  send = async (target: string, message: string): Promise<void> => {
    this.seq++
    const id = `ask${this.seq}`
    this.asks.set(id, {
      id,
      from: this.selfName,
      // The channel target is who the answer routes back through, not who is asking.
      target,
      question: message,
      askedAt: Date.now(),
      kind: 'ask',
    })
  }

  /**
   * A one-way notification card: task run results, milestones. Nothing awaits an answer —
   * the console shows it until dismissed. Without this, a task whose channel has no outbound
   * sender logs a warning and its reports are never seen at all.
   */
  notice = async (target: string, message: string): Promise<void> => {
    this.seq++
    const id = `ask${this.seq}`
    this.asks.set(id, {
      id,
      from: this.selfName,
      target,
      question: message,
      askedAt: Date.now(),
      kind: 'notice',
    })
  }

  list(): ConsoleAsk[] {
    return [...this.asks.values()].sort((a, b) => a.askedAt - b.askedAt)
  }

  get(id: string): ConsoleAsk | undefined {
    return this.asks.get(id)
  }

  /** Remove an ask once it has been answered — or abandoned when its asker timed out. */
  resolve(id: string): boolean {
    return this.asks.delete(id)
  }

  /**
   * Drop asks whose asker has certainly stopped waiting. The broker resolves a timed-out ask on
   * its own, but nothing tells the inbox — without this, the console would keep showing
   * questions that nobody is listening for an answer to, which is worse than showing none.
   */
  prune(maxAgeMs: number, now = Date.now()): number {
    let dropped = 0
    for (const [id, ask] of this.asks) {
      // A notice has no waiting asker to outlive — keep it a full day so an overnight run's
      // report is still there in the morning.
      const limit = ask.kind === 'notice' ? Math.max(maxAgeMs, 24 * 60 * 60 * 1000) : maxAgeMs
      if (now - ask.askedAt > limit) {
        this.asks.delete(id)
        dropped++
      }
    }
    return dropped
  }
}
