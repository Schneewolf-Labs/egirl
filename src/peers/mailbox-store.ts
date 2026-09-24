import type { Database } from 'bun:sqlite'
import { openDatabase } from '../util/db'

/** Work this instance handed to another agent, keyed by the Wald thread it went out on. */
export interface Delegation {
  threadId: string
  /** The session that delegated, and that the reply resumes (`task:<id>` parks and resumes). */
  sessionId: string
  /** Slug of the agent the work went to. Only it may answer on this thread. */
  agent: string
  /** What was asked, so the reply can be read without the delegating run's transcript. */
  request: string
  createdAt: number
}

/** What an inbox message became. Recorded before the ack; the ack is only a receipt. */
export type MailOutcome = 'reply' | 'task' | 'recorded' | 'untrusted'

/**
 * Mailbox bookkeeping. Two facts only:
 *
 * - `threads`: delegations waiting on an answer, so a reply can find the run that asked.
 * - `seen`: messages already recorded. Wald is at-least-once — a crash between recording a
 *   message and acking it re-delivers it — and this is what turns the second delivery into a
 *   no-op instead of a second task.
 */
export class MailboxStore {
  private db: Database

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS mailbox_threads (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        request TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS mailbox_seen (
        message_id TEXT PRIMARY KEY,
        outcome TEXT NOT NULL,
        ref TEXT,
        seen_at INTEGER NOT NULL
      )
    `)
  }

  recordDelegation(d: Omit<Delegation, 'createdAt'>): void {
    this.db.run(
      'INSERT OR REPLACE INTO mailbox_threads (thread_id, session_id, agent, request, created_at) VALUES (?, ?, ?, ?, ?)',
      [d.threadId, d.sessionId, d.agent, d.request, Date.now()],
    )
  }

  forgetDelegation(threadId: string): void {
    this.db.run('DELETE FROM mailbox_threads WHERE thread_id = ?', [threadId])
  }

  getDelegation(threadId: string): Delegation | undefined {
    const row = this.db
      .query('SELECT * FROM mailbox_threads WHERE thread_id = ?')
      .get(threadId) as Record<string, unknown> | null
    if (!row) return undefined
    return {
      threadId: row.thread_id as string,
      sessionId: row.session_id as string,
      agent: row.agent as string,
      request: row.request as string,
      createdAt: row.created_at as number,
    }
  }

  isSeen(messageId: string): boolean {
    return !!this.db.query('SELECT 1 FROM mailbox_seen WHERE message_id = ?').get(messageId)
  }

  markSeen(messageId: string, outcome: MailOutcome, ref?: string): void {
    this.db.run(
      'INSERT OR IGNORE INTO mailbox_seen (message_id, outcome, ref, seen_at) VALUES (?, ?, ?, ?)',
      [messageId, outcome, ref ?? null, Date.now()],
    )
  }

  close(): void {
    this.db.close()
  }
}

export function createMailboxStore(dbPath: string): MailboxStore {
  return new MailboxStore(dbPath)
}
