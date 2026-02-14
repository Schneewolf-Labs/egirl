import { Database } from 'bun:sqlite'
import { log } from '../util/logger'

export type ContentType = 'text' | 'image' | 'multimodal'

export type MemoryCategory =
  | 'general'
  | 'fact'
  | 'preference'
  | 'decision'
  | 'project'
  | 'entity'
  | 'conversation'

export type MemorySource = 'manual' | 'auto' | 'conversation'

export interface IndexedMemory {
  id: number
  key: string
  value: string
  contentType: ContentType
  category: MemoryCategory
  source: MemorySource
  sessionId?: string
  imagePath?: string  // Path to stored image file
  embedding?: Float32Array
  createdAt: number
  updatedAt: number
}

export class MemoryIndexer {
  private db: Database
  private dimensions: number

  constructor(dbPath: string, dimensions = 2048) {
    this.db = new Database(dbPath)
    this.dimensions = dimensions
    this.initialize()
  }

  private initialize(): void {
    // Main memories table with multimodal support
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text',
        category TEXT NOT NULL DEFAULT 'general',
        source TEXT NOT NULL DEFAULT 'manual',
        session_id TEXT,
        image_path TEXT,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)

    // Migrate existing DBs: add new columns if missing
    this.migrate()

    // FTS for text search
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        key, value, content=memories, content_rowid=id
      )
    `)

    // Triggers to keep FTS in sync
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
      END
    `)

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
      END
    `)

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
        INSERT INTO memories_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
      END
    `)

    // Index for category and time-range queries
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source)
    `)

    log.debug('memory', 'Memory indexer initialized')
  }

  private migrate(): void {
    // Check if new columns exist, add them if not
    const columns = this.db.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>
    const columnNames = new Set(columns.map(c => c.name))

    if (!columnNames.has('category')) {
      this.db.run("ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'general'")
      log.info('memory', 'Migrated: added category column')
    }
    if (!columnNames.has('source')) {
      this.db.run("ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
      log.info('memory', 'Migrated: added source column')
    }
    if (!columnNames.has('session_id')) {
      this.db.run("ALTER TABLE memories ADD COLUMN session_id TEXT")
      log.info('memory', 'Migrated: added session_id column')
    }
  }

  set(
    key: string,
    value: string,
    options: {
      contentType?: ContentType
      category?: MemoryCategory
      source?: MemorySource
      sessionId?: string
      imagePath?: string
      embedding?: Float32Array
    } = {}
  ): void {
    const now = Date.now()
    const {
      contentType = 'text',
      category = 'general',
      source = 'manual',
      sessionId,
      imagePath,
      embedding,
    } = options

    const stmt = this.db.prepare(`
      INSERT INTO memories (key, value, content_type, category, source, session_id, image_path, embedding, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        content_type = excluded.content_type,
        category = excluded.category,
        source = excluded.source,
        session_id = excluded.session_id,
        image_path = excluded.image_path,
        embedding = excluded.embedding,
        updated_at = excluded.updated_at
    `)

    stmt.run(
      key,
      value,
      contentType,
      category,
      source,
      sessionId ?? null,
      imagePath ?? null,
      embedding ? Buffer.from(embedding.buffer) : null,
      now,
      now
    )
  }

  get(key: string): IndexedMemory | null {
    const row = this.db.query(`
      SELECT id, key, value, content_type, category, source, session_id, image_path, embedding, created_at, updated_at
      FROM memories WHERE key = ?
    `).get(key) as MemoryRow | null

    if (!row) return null
    return rowToMemory(row)
  }

  /**
   * Get all memories with embeddings for vector search
   */
  getAllWithEmbeddings(): IndexedMemory[] {
    const rows = this.db.query(`
      SELECT id, key, value, content_type, category, source, session_id, image_path, embedding, created_at, updated_at
      FROM memories
      WHERE embedding IS NOT NULL
    `).all() as MemoryRow[]

    return rows.map(rowToMemory)
  }

  /**
   * Get memories by content type
   */
  getByContentType(contentType: ContentType, limit = 100): IndexedMemory[] {
    const rows = this.db.query(`
      SELECT id, key, value, content_type, category, source, session_id, image_path, embedding, created_at, updated_at
      FROM memories
      WHERE content_type = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(contentType, limit) as MemoryRow[]

    return rows.map(rowToMemory)
  }

  searchFTS(query: string, limit = 10): IndexedMemory[] {
    const rows = this.db.query(`
      SELECT m.id, m.key, m.value, m.content_type, m.category, m.source, m.session_id,
             m.image_path, m.created_at, m.updated_at
      FROM memories m
      JOIN memories_fts fts ON m.id = fts.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as MemoryRow[]

    return rows.map(rowToMemory)
  }

  list(
    limit = 100,
    offset = 0,
    filters?: { category?: MemoryCategory; source?: MemorySource; since?: number; until?: number }
  ): Array<{ key: string; value: string; contentType: ContentType; category: MemoryCategory; source: MemorySource; createdAt: number; updatedAt: number }> {
    let sql = 'SELECT key, value, content_type, category, source, created_at, updated_at FROM memories WHERE 1=1'
    const params: (string | number)[] = []

    if (filters?.category) {
      sql += ' AND category = ?'
      params.push(filters.category)
    }
    if (filters?.source) {
      sql += ' AND source = ?'
      params.push(filters.source)
    }
    if (filters?.since) {
      sql += ' AND created_at >= ?'
      params.push(filters.since)
    }
    if (filters?.until) {
      sql += ' AND created_at <= ?'
      params.push(filters.until)
    }

    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?'
    params.push(limit, offset)

    const rows = this.db.query(sql).all(...params) as Array<{
      key: string
      value: string
      content_type: string
      category: string
      source: string
      created_at: number
      updated_at: number
    }>

    return rows.map(row => ({
      key: row.key,
      value: row.value,
      contentType: row.content_type as ContentType,
      category: row.category as MemoryCategory,
      source: row.source as MemorySource,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  getByCategory(category: MemoryCategory, limit = 100): IndexedMemory[] {
    const rows = this.db.query(`
      SELECT id, key, value, content_type, category, source, session_id, image_path, embedding, created_at, updated_at
      FROM memories
      WHERE category = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(category, limit) as MemoryRow[]

    return rows.map(rowToMemory)
  }

  getByTimeRange(since: number, until?: number, limit = 100): IndexedMemory[] {
    const untilTs = until ?? Date.now()
    const rows = this.db.query(`
      SELECT id, key, value, content_type, category, source, session_id, image_path, embedding, created_at, updated_at
      FROM memories
      WHERE created_at >= ? AND created_at <= ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(since, untilTs, limit) as MemoryRow[]

    return rows.map(rowToMemory)
  }

  count(): number {
    const row = this.db.query(`SELECT COUNT(*) as count FROM memories`).get() as { count: number }
    return row.count
  }

  delete(key: string): boolean {
    const result = this.db.run(`DELETE FROM memories WHERE key = ?`, [key])
    return result.changes > 0
  }

  close(): void {
    this.db.close()
  }
}

/** Raw row shape from SQLite queries */
interface MemoryRow {
  id: number
  key: string
  value: string
  content_type: string
  category: string
  source: string
  session_id: string | null
  image_path: string | null
  embedding: Buffer | null
  created_at: number
  updated_at: number
}

function rowToMemory(row: MemoryRow): IndexedMemory {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    contentType: row.content_type as ContentType,
    category: (row.category ?? 'general') as MemoryCategory,
    source: (row.source ?? 'manual') as MemorySource,
    sessionId: row.session_id ?? undefined,
    imagePath: row.image_path ?? undefined,
    embedding: row.embedding ? new Float32Array(row.embedding.buffer) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createMemoryIndexer(dbPath: string, dimensions?: number): MemoryIndexer {
  return new MemoryIndexer(dbPath, dimensions)
}
