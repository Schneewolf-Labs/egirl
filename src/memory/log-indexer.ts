import { log } from '../util/logger'
import type { MemoryManager } from './index'
import type { MemoryFiles } from './files'

/**
 * Indexes daily conversation logs into the memory vector store (Tier 2).
 *
 * Daily logs are append-only files in workspace/logs/YYYY-MM-DD.md.
 * This indexer reads them, chunks by timestamp entries, and stores
 * each chunk as a memory with source='conversation' so they're
 * searchable via hybrid search without polluting Tier 1 context.
 */

const CHUNK_MAX_CHARS = 1500
const LOG_ENTRY_PATTERN = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s*/

interface LogChunk {
  date: string
  content: string
  firstTimestamp: string
}

/**
 * Parse a daily log file into chunks suitable for embedding.
 * Groups consecutive log entries up to CHUNK_MAX_CHARS.
 */
export function chunkDailyLog(date: string, content: string): LogChunk[] {
  if (!content.trim()) return []

  const lines = content.split('\n').filter((l) => l.trim())
  const chunks: LogChunk[] = []
  let currentLines: string[] = []
  let currentSize = 0
  let firstTimestamp = ''

  for (const line of lines) {
    const match = line.match(LOG_ENTRY_PATTERN)
    const timestamp = match?.[1] ?? ''

    // Start a new chunk if this entry would exceed the limit
    if (currentSize + line.length > CHUNK_MAX_CHARS && currentLines.length > 0) {
      chunks.push({
        date,
        content: currentLines.join('\n'),
        firstTimestamp: firstTimestamp || date,
      })
      currentLines = []
      currentSize = 0
      firstTimestamp = ''
    }

    if (!firstTimestamp && timestamp) {
      firstTimestamp = timestamp
    }

    currentLines.push(line)
    currentSize += line.length + 1
  }

  // Flush remaining
  if (currentLines.length > 0) {
    chunks.push({
      date,
      content: currentLines.join('\n'),
      firstTimestamp: firstTimestamp || date,
    })
  }

  return chunks
}

/**
 * Build a deterministic memory key for a log chunk.
 * Uses date + chunk index so re-indexing the same log is idempotent.
 */
function chunkKey(date: string, index: number): string {
  return `log:${date}:${index}`
}

/**
 * Index all unindexed daily logs into the memory store.
 * Skips dates that already have log chunks indexed (idempotent).
 */
export async function indexDailyLogs(
  memory: MemoryManager,
  files: MemoryFiles,
): Promise<{ indexed: number; skipped: number }> {
  const dates = await files.listDailyLogs()
  let indexed = 0
  let skipped = 0

  for (const date of dates) {
    // Check if first chunk for this date already exists — skip if so
    const existing = memory.get(chunkKey(date, 0))
    if (existing) {
      skipped++
      continue
    }

    const content = await files.readDailyLog(date)
    const chunks = chunkDailyLog(date, content)

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const key = chunkKey(date, i)

      try {
        await memory.set(key, chunk.content, {
          category: 'conversation',
          source: 'conversation',
        })
      } catch (error) {
        log.warn('log-indexer', `Failed to index chunk ${key}:`, error)
      }
    }

    if (chunks.length > 0) {
      indexed++
      log.debug('log-indexer', `Indexed ${chunks.length} chunks from ${date}`)
    }
  }

  if (indexed > 0) {
    log.info('log-indexer', `Indexed ${indexed} daily logs (${skipped} already indexed)`)
  }

  return { indexed, skipped }
}
