import { Database } from 'bun:sqlite'
import type { ChatMessage, ToolCall } from '../providers/types'
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
    this.db = new Database(dbPath)
    this.db.run('PRAGMA journal_mode=WAL')
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

    log.debug('conversation', 'Conversation store initialized')
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
