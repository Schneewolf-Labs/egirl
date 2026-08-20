import type { Database } from 'bun:sqlite'
import type { ChatMessage, ToolCall } from '../providers/types'
import { openDatabase } from '../util/db'
import { log } from '../util/logger'

export interface SessionInfo {
  id: string
  channel: string
  messageCount: number
  createdAt: number
  lastActiveAt: number
}

export interface CompactResult {
  sessionsDeleted: number
  messagesDeleted: number
}

export class ConversationStore {
  private db: Database

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath)
    this.initialize()
  }

  private initialize(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        summary TEXT
      )
    `)

    // Migration: add summary column if it doesn't exist (for existing databases)
    try {
      this.db.run('ALTER TABLE sessions ADD COLUMN summary TEXT')
    } catch {
      // Column already exists — ignore
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        created_at INTEGER NOT NULL
      )
    `)

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, id)
    `)

    this.initializeSearch()

    log.debug('conversation', 'Conversation store initialized')
  }

  /**
   * Full-text index over message content, kept in sync by triggers.
   *
   * External-content FTS5 rather than a copy: the index stores only tokens and rowids, and
   * reads join back to `messages` for everything else. Messages are inserted and deleted but
   * never updated, so two triggers cover the whole write surface. Failure here downgrades to
   * "search unavailable" rather than breaking conversation persistence -- an agent that
   * cannot search its past is degraded; one that cannot remember it is broken.
   */
  private searchAvailable = false

  private initializeSearch(): void {
    try {
      // Backfill detection has to happen BEFORE the CREATE: with external-content FTS5,
      // COUNT(*) on the index table proxies to the content table, so comparing row counts
      // after creation always reports "fully indexed" -- an empty index and a complete one
      // are indistinguishable that way. "The table did not exist yet" is the one reliable
      // signal that existing messages predate the index.
      const hadIndex = !!this.db
        .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`)
        .get()

      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
        USING fts5(content, content='messages', content_rowid='id')
      `)
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END
      `)
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
        END
      `)

      if (!hadIndex) {
        const msgCount = (
          this.db.query('SELECT COUNT(*) as c FROM messages').get() as { c: number }
        ).c
        if (msgCount > 0) {
          log.info('conversation', `Building message search index over ${msgCount} messages`)
          this.db.run(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`)
        }
      }

      this.searchAvailable = true
    } catch (error) {
      log.warn('conversation', 'FTS5 unavailable — session search disabled:', error)
    }
  }

  /**
   * Search message content across all sessions.
   *
   * The query is user/model text, not FTS5 grammar: terms are extracted and quoted so
   * characters FTS5's parser rejects outside a phrase ("+", "(", '"', …) cannot produce a
   * syntax error -- hermes-agent's session search learned this list the hard way.
   */
  searchMessages(
    query: string,
    opts: { limit?: number; excludeSession?: string } = {},
  ): Array<{ sessionId: string; role: string; snippet: string; createdAt: number }> {
    if (!this.searchAvailable) return []
    const terms = query.match(/[\p{L}\p{N}'.]+/gu) ?? []
    if (terms.length === 0) return []
    const quoted = terms.map((t) => `"${t.replaceAll('"', '')}"`)

    // All terms first; when that finds nothing and there were several, fall back to ANY.
    // A half-remembered query usually has one term that is wrong ("was it offset or
    // header?"), and strict AND would punish exactly the queries this tool exists for.
    const andHits = this.runSearch(quoted.join(' '), opts)
    if (andHits.length > 0 || quoted.length < 2) return andHits
    return this.runSearch(quoted.join(' OR '), opts)
  }

  private runSearch(
    match: string,
    opts: { limit?: number; excludeSession?: string },
  ): Array<{ sessionId: string; role: string; snippet: string; createdAt: number }> {
    try {
      const rows = this.db
        .query(`
          SELECT m.session_id as sessionId, m.role as role, m.created_at as createdAt,
            snippet(messages_fts, 0, '»', '«', ' … ', 14) as snippet
          FROM messages_fts f
          JOIN messages m ON m.id = f.rowid
          WHERE messages_fts MATCH ?
            AND m.role IN ('user', 'assistant')
            AND m.session_id != ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(match, opts.excludeSession ?? '', opts.limit ?? 12)
      return rows as Array<{
        sessionId: string
        role: string
        snippet: string
        createdAt: number
      }>
    } catch (error) {
      log.warn('conversation', 'Session search failed:', error)
      return []
    }
  }

  loadMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .query(`
      SELECT role, content, tool_calls, tool_call_id
      FROM messages
      WHERE session_id = ?
      ORDER BY id ASC
    `)
      .all(sessionId) as Array<{
      role: string
      content: string
      tool_calls: string | null
      tool_call_id: string | null
    }>

    const messages: ChatMessage[] = []
    for (const row of rows) {
      try {
        const msg: ChatMessage = {
          role: row.role as ChatMessage['role'],
          content: JSON.parse(row.content),
        }
        if (row.tool_calls) {
          msg.tool_calls = JSON.parse(row.tool_calls) as ToolCall[]
        }
        if (row.tool_call_id) {
          msg.tool_call_id = row.tool_call_id
        }
        messages.push(msg)
      } catch (error) {
        log.warn('conversation', `Skipping malformed message in session ${sessionId}:`, error)
      }
    }
    return messages
  }

  appendMessages(sessionId: string, messages: ChatMessage[]): void {
    if (messages.length === 0) return

    const now = Date.now()
    const channel = sessionId.split(':')[0] ?? 'unknown'

    this.db.transaction(() => {
      this.db.run(
        `
        INSERT INTO sessions (id, channel, created_at, last_active_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_active_at = excluded.last_active_at
      `,
        [sessionId, channel, now, now],
      )

      const stmt = this.db.prepare(`
        INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)

      for (const msg of messages) {
        stmt.run(
          sessionId,
          msg.role,
          JSON.stringify(msg.content),
          msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
          msg.tool_call_id ?? null,
          now,
        )
      }
    })()
  }

  loadSummary(sessionId: string): string | undefined {
    const row = this.db.query('SELECT summary FROM sessions WHERE id = ?').get(sessionId) as {
      summary: string | null
    } | null

    return row?.summary ?? undefined
  }

  updateSummary(sessionId: string, summary: string): void {
    this.db.run('UPDATE sessions SET summary = ? WHERE id = ?', [summary, sessionId])
  }

  deleteSession(sessionId: string): boolean {
    return this.db.transaction(() => {
      this.db.run('DELETE FROM messages WHERE session_id = ?', [sessionId])
      const result = this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId])
      return result.changes > 0
    })()
  }

  compact(options: { maxAgeDays: number; maxMessages: number }): CompactResult {
    const cutoff = Date.now() - options.maxAgeDays * 86_400_000
    let sessionsDeleted = 0
    let messagesDeleted = 0

    this.db.transaction(() => {
      // Delete expired sessions
      const expired = this.db
        .query('SELECT id FROM sessions WHERE last_active_at < ?')
        .all(cutoff) as Array<{ id: string }>

      for (const { id } of expired) {
        const msgResult = this.db.run('DELETE FROM messages WHERE session_id = ?', [id])
        messagesDeleted += msgResult.changes
        this.db.run('DELETE FROM sessions WHERE id = ?', [id])
        sessionsDeleted++
      }

      // Trim sessions that exceed max messages (keep newest)
      const oversized = this.db
        .query(`
        SELECT session_id, COUNT(*) as count
        FROM messages
        GROUP BY session_id
        HAVING count > ?
      `)
        .all(options.maxMessages) as Array<{ session_id: string; count: number }>

      for (const { session_id, count } of oversized) {
        const excess = count - options.maxMessages
        const result = this.db.run(
          `
          DELETE FROM messages
          WHERE id IN (
            SELECT id FROM messages
            WHERE session_id = ?
            ORDER BY id ASC
            LIMIT ?
          )
        `,
          [session_id, excess],
        )
        messagesDeleted += result.changes
      }
    })()

    if (sessionsDeleted > 0 || messagesDeleted > 0) {
      log.info(
        'conversation',
        `Compacted: ${sessionsDeleted} sessions, ${messagesDeleted} messages removed`,
      )
    }

    return { sessionsDeleted, messagesDeleted }
  }

  listSessions(): SessionInfo[] {
    const rows = this.db
      .query(`
      SELECT s.id, s.channel, s.created_at, s.last_active_at,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count
      FROM sessions s
      ORDER BY s.last_active_at DESC
    `)
      .all() as Array<{
      id: string
      channel: string
      created_at: number
      last_active_at: number
      message_count: number
    }>

    return rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      messageCount: row.message_count,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    }))
  }

  close(): void {
    this.db.close()
  }
}

export function createConversationStore(dbPath: string): ConversationStore {
  return new ConversationStore(dbPath)
}
