import { Database } from 'bun:sqlite'
import { log } from '../util/logger'

export type ContentType = 'text' | 'image' | 'multimodal'

export interface IndexedMemory {
  id: number
  key: string
  value: string
  contentType: ContentType
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
        image_path TEXT,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)

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

    log.debug('memory', 'Memory indexer initialized')
  }

  set(
    key: string,
    value: string,
    options: {
      contentType?: ContentType
      imagePath?: string
      embedding?: Float32Array
    } = {}
  ): void {
    const now = Date.now()
    const { contentType = 'text', imagePath, embedding } = options

    const stmt = this.db.prepare(`
      INSERT INTO memories (key, value, content_type, image_path, embedding, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        content_type = excluded.content_type,
        image_path = excluded.image_path,
        embedding = excluded.embedding,
        updated_at = excluded.updated_at
    `)

    stmt.run(
      key,
      value,
      contentType,
      imagePath ?? null,
      embedding ? Buffer.from(embedding.buffer) : null,
      now,
      now
    )
  }

  get(key: string): IndexedMemory | null {
    const row = this.db.query(`
      SELECT id, key, value, content_type, image_path, embedding, created_at, updated_at
      FROM memories WHERE key = ?
    `).get(key) as {
      id: number
      key: string
      value: string
      content_type: string
      image_path: string | null
      embedding: Buffer | null
      created_at: number
      updated_at: number
    } | null

    if (!row) return null

    return {
      id: row.id,
      key: row.key,
      value: row.value,
      contentType: row.content_type as ContentType,
      imagePath: row.image_path ?? undefined,
      embedding: row.embedding ? new Float32Array(row.embedding.buffer) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Get all memories with embeddings for vector search
   */
  getAllWithEmbeddings(): IndexedMemory[] {
    const rows = this.db.query(`
      SELECT id, key, value, content_type, image_path, embedding, created_at, updated_at
      FROM memories
      WHERE embedding IS NOT NULL
    `).all() as Array<{
      id: number
      key: string
      value: string
      content_type: string
      image_path: string | null
      embedding: Buffer
      created_at: number
      updated_at: number
    }>

    return rows.map(row => ({
      id: row.id,
      key: row.key,
      value: row.value,
      contentType: row.content_type as ContentType,
      imagePath: row.image_path ?? undefined,
      embedding: new Float32Array(row.embedding.buffer),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  /**
   * Get memories by content type
   */
  getByContentType(contentType: ContentType, limit = 100): IndexedMemory[] {
    const rows = this.db.query(`
      SELECT id, key, value, content_type, image_path, embedding, created_at, updated_at
      FROM memories
      WHERE content_type = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(contentType, limit) as Array<{
      id: number
      key: string
      value: string
      content_type: string
      image_path: string | null
      embedding: Buffer | null
      created_at: number
      updated_at: number
    }>

    return rows.map(row => ({
      id: row.id,
      key: row.key,
      value: row.value,
      contentType: row.content_type as ContentType,
      imagePath: row.image_path ?? undefined,
      embedding: row.embedding ? new Float32Array(row.embedding.buffer) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  searchFTS(query: string, limit = 10): IndexedMemory[] {
    const rows = this.db.query(`
      SELECT m.id, m.key, m.value, m.content_type, m.image_path, m.created_at, m.updated_at
      FROM memories m
      JOIN memories_fts fts ON m.id = fts.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as Array<{
      id: number
      key: string
      value: string
      content_type: string
      image_path: string | null
      created_at: number
      updated_at: number
    }>

    return rows.map(row => ({
      id: row.id,
      key: row.key,
      value: row.value,
      contentType: row.content_type as ContentType,
      imagePath: row.image_path ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  delete(key: string): boolean {
    const result = this.db.run(`DELETE FROM memories WHERE key = ?`, [key])
    return result.changes > 0
  }

  close(): void {
    this.db.close()
  }
}

export function createMemoryIndexer(dbPath: string, dimensions?: number): MemoryIndexer {
  return new MemoryIndexer(dbPath, dimensions)
}
