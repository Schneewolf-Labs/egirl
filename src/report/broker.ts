import type { Database } from 'bun:sqlite'
import { openDatabase } from '../util/db'
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
 *
 * Across processes: an instance often runs as `serve` (which owns the chat channels and hears
 * replies) and `api` (which runs tasks but only sends on chat). Kept in memory alone, an ask
 * parked by a task in `api` could never be answered: the reply reached `serve`'s broker, found
 * nothing waiting there, and started a fresh conversation instead. Given a `dbPath` shared by
 * the processes (the workspace's asks.db), every ask is also a row; the process that hears a
 * reply hands it to the oldest waiting row whichever process owns it, and each process polls
 * for replies left on its own rows.
 */

interface PendingAsk {
  id: string
  resolve: (reply: string | undefined) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ReplyBrokerOptions {
  /** SQLite file shared by every egirl process on this workspace. Omit for an in-process broker. */
  dbPath?: string
  /** How often a process checks the shared file for replies to its asks. */
  pollMs?: number
}

export class ReplyBroker {
  private pending = new Map<string, PendingAsk[]>()
  private db?: Database
  private readonly owner = crypto.randomUUID()
  private readonly pollMs: number
  private poller?: ReturnType<typeof setInterval>

  constructor(options: ReplyBrokerOptions = {}) {
    this.pollMs = options.pollMs ?? 1000
    if (options.dbPath) {
      this.db = openDatabase(options.dbPath)
      this.db.run(`CREATE TABLE IF NOT EXISTS report_asks (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        owner TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        reply TEXT
      )`)
      this.db.run('CREATE INDEX IF NOT EXISTS idx_report_asks_key ON report_asks(key, created_at)')
      this.db.run('DELETE FROM report_asks WHERE expires_at < ?', [Date.now()])
    }
  }

  private key(channel: string, target: string): string {
    return `${channel}:${target.toLowerCase()}`
  }

  private take(key: string, id: string): PendingAsk | undefined {
    const queue = this.pending.get(key)
    if (!queue) return undefined
    const i = queue.findIndex((e) => e.id === id)
    if (i < 0) return undefined
    const [entry] = queue.splice(i, 1)
    if (queue.length === 0) this.pending.delete(key)
    if (this.pending.size === 0) this.stopPolling()
    return entry
  }

  /** Park until the next inbound message from (channel, target), or undefined on timeout. */
  awaitReply(channel: string, target: string, timeoutMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const key = this.key(channel, target)
      const id = crypto.randomUUID()
      const entry: PendingAsk = {
        id,
        resolve,
        timer: setTimeout(() => {
          this.take(key, id)
          this.db?.run('DELETE FROM report_asks WHERE id = ?', [id])
          resolve(undefined)
        }, timeoutMs),
      }
      const queue = this.pending.get(key) ?? []
      queue.push(entry)
      this.pending.set(key, queue)
      if (this.db) {
        const now = Date.now()
        this.db.run(
          'INSERT INTO report_asks (id, key, owner, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
          [id, key, this.owner, now, now + timeoutMs],
        )
        this.startPolling()
      }
    })
  }

  /**
   * Offer an inbound message to the oldest ask waiting on (channel, target).
   * Returns true when consumed — the channel should NOT dispatch it to the agent.
   */
  tryDeliver(channel: string, target: string, message: string): boolean {
    const key = this.key(channel, target)
    if (!this.db) {
      const entry = this.pending.get(key)?.[0]
      if (!entry) return false
      this.take(key, entry.id)
      clearTimeout(entry.timer)
      entry.resolve(message)
      log.info('report', `Inbound message from ${key} delivered to a pending ask`)
      return true
    }

    const row = this.db
      .query(
        'SELECT id, owner FROM report_asks WHERE key = ? AND reply IS NULL AND expires_at >= ? ORDER BY created_at LIMIT 1',
      )
      .get(key, Date.now()) as { id: string; owner: string } | null
    if (!row) return false
    if (row.owner === this.owner) {
      const entry = this.take(key, row.id)
      this.db.run('DELETE FROM report_asks WHERE id = ?', [row.id])
      if (!entry) return false
      clearTimeout(entry.timer)
      entry.resolve(message)
      log.info('report', `Inbound message from ${key} delivered to a pending ask`)
      return true
    }
    // Owned by another process: leave the reply on its row for that process to collect.
    const claimed = this.db.run('UPDATE report_asks SET reply = ? WHERE id = ? AND reply IS NULL', [
      message,
      row.id,
    ])
    if (claimed.changes !== 1) return false
    log.info('report', `Inbound message from ${key} delivered to an ask pending in another process`)
    return true
  }

  hasPending(channel: string, target: string): boolean {
    const key = this.key(channel, target)
    if (!this.db) return (this.pending.get(key)?.length ?? 0) > 0
    const row = this.db
      .query(
        'SELECT 1 FROM report_asks WHERE key = ? AND reply IS NULL AND expires_at >= ? LIMIT 1',
      )
      .get(key, Date.now())
    return row !== null
  }

  /** Collect replies another process left on this process's asks. */
  private poll(): void {
    if (!this.db) return
    const rows = this.db
      .query('SELECT id, key, reply FROM report_asks WHERE owner = ? AND reply IS NOT NULL')
      .all(this.owner) as Array<{ id: string; key: string; reply: string }>
    for (const row of rows) {
      this.db.run('DELETE FROM report_asks WHERE id = ?', [row.id])
      const entry = this.take(row.key, row.id)
      if (!entry) continue
      clearTimeout(entry.timer)
      entry.resolve(row.reply)
    }
  }

  private startPolling(): void {
    if (this.poller) return
    this.poller = setInterval(() => this.poll(), this.pollMs)
    // An idle broker must not keep a process alive.
    this.poller.unref?.()
  }

  private stopPolling(): void {
    if (!this.poller) return
    clearInterval(this.poller)
    this.poller = undefined
  }
}

export function createReplyBroker(options: ReplyBrokerOptions = {}): ReplyBroker {
  return new ReplyBroker(options)
}
