/**
 * Working memory with TTL.
 *
 * Inspired by Hexis's working memory concept: transient context that
 * auto-expires without polluting long-term memory. Useful for "remember
 * this for the next hour" type information.
 *
 * Implemented as a separate SQLite table with TTL-based expiry.
 * Unlike long-term memories, working memory entries:
 * - Have a configurable TTL (default 1 hour)
 * - Are not embedded or indexed for vector search
 * - Can be promoted to long-term memory if flagged
 * - Are cleaned up automatically on access
 */

import { Database } from 'bun:sqlite'
import { log } from '../util/logger'

export interface WorkingMemoryEntry {
  id: number
  key: string
  value: string
  context: string
  expiresAt: number
  promote: boolean
  createdAt: number
}

/** Default TTL: 1 hour */
const DEFAULT_TTL_MS = 60 * 60 * 1000

export class WorkingMemory {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.initialize()
  }

  private initialize(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS working_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        promote INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `)

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_working_memory_expires
      ON working_memory(expires_at)
    `)

    log.debug('memory', 'Working memory initialized')
  }

  /** Store a transient memory with TTL */
  set(key: string, value: string, options: { ttlMs?: number; context?: string } = {}): void {
    const now = Date.now()
    const ttl = options.ttlMs ?? DEFAULT_TTL_MS
    const expiresAt = now + ttl

    this.db.run(
      `INSERT INTO working_memory (key, value, context, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         context = excluded.context,
         expires_at = excluded.expires_at`,
      [key, value, options.context ?? '', expiresAt, now],
    )

    log.debug('memory', `Working memory set: ${key} (TTL: ${Math.round(ttl / 60000)}min)`)
  }

  /** Get a working memory entry (returns null if expired or missing) */
  get(key: string): WorkingMemoryEntry | null {
    this.sweep()
    const row = this.db
      .query(
        'SELECT id, key, value, context, expires_at, promote, created_at FROM working_memory WHERE key = ?',
      )
      .get(key) as WorkingMemoryRow | null

    if (!row) return null
    return rowToEntry(row)
  }

  /** Get all active (non-expired) working memory entries */
  getAll(): WorkingMemoryEntry[] {
    this.sweep()
    const rows = this.db
      .query(
        'SELECT id, key, value, context, expires_at, promote, created_at FROM working_memory ORDER BY created_at DESC',
      )
      .all() as WorkingMemoryRow[]

    return rows.map(rowToEntry)
  }

  /** Mark a working memory entry for promotion to long-term memory */
  markForPromotion(key: string): boolean {
    const result = this.db.run('UPDATE working_memory SET promote = 1 WHERE key = ?', [key])
    return result.changes > 0
  }

  /** Get entries marked for promotion (called by memory manager during maintenance) */
  getPromotionCandidates(): WorkingMemoryEntry[] {
    const rows = this.db
      .query(
        'SELECT id, key, value, context, expires_at, promote, created_at FROM working_memory WHERE promote = 1',
      )
      .all() as WorkingMemoryRow[]

    return rows.map(rowToEntry)
  }

  /** Remove a working memory entry */
  delete(key: string): boolean {
    const result = this.db.run('DELETE FROM working_memory WHERE key = ?', [key])
    return result.changes > 0
  }

  /** Remove expired entries */
  sweep(): number {
    const now = Date.now()
    const result = this.db.run('DELETE FROM working_memory WHERE expires_at <= ? AND promote = 0', [
      now,
    ])
    if (result.changes > 0) {
      log.debug('memory', `Swept ${result.changes} expired working memory entries`)
    }
    return result.changes
  }

  /** Count active (non-expired) entries */
  count(): number {
    this.sweep()
    const row = this.db.query('SELECT COUNT(*) as count FROM working_memory').get() as {
      count: number
    }
    return row.count
  }

  /**
   * Build a context string from active working memory for injection
   * into the conversation. Returns undefined if nothing is active.
   */
  buildContext(): string | undefined {
    const entries = this.getAll()
    if (entries.length === 0) return undefined

    const lines = entries.map((e) => {
      const ttlMin = Math.max(0, Math.round((e.expiresAt - Date.now()) / 60000))
      const ctx = e.context ? ` (${e.context})` : ''
      return `- [${e.key}]${ctx}: ${e.value} [expires in ${ttlMin}min]`
    })

    return `[Active working memory:\n${lines.join('\n')}]`
  }

  close(): void {
    this.db.close()
  }
}

interface WorkingMemoryRow {
  id: number
  key: string
  value: string
  context: string
  expires_at: number
  promote: number
  created_at: number
}

function rowToEntry(row: WorkingMemoryRow): WorkingMemoryEntry {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    context: row.context,
    expiresAt: row.expires_at,
    promote: row.promote === 1,
    createdAt: row.created_at,
  }
}

export function createWorkingMemory(dbPath: string): WorkingMemory {
  return new WorkingMemory(dbPath)
}
