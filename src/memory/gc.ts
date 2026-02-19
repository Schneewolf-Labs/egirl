import { log } from '../util/logger'
import type { MemoryIndexer } from './indexer'

export interface GCConfig {
  /** Max age (ms) for auto-extracted memories with zero accesses before pruning */
  autoMaxAge: number
  /** Max age (ms) for conversation-source memories before pruning */
  conversationMaxAge: number
  /** Dry run — log what would be deleted without actually deleting */
  dryRun: boolean
}

const DEFAULT_CONFIG: GCConfig = {
  autoMaxAge: 14 * 24 * 60 * 60 * 1000, // 14 days
  conversationMaxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  dryRun: false,
}

export interface GCResult {
  deleted: string[]
  skipped: number
}

/**
 * Garbage-collect stale memories.
 *
 * Targets:
 * - auto/* keys with access_count=0 older than autoMaxAge
 * - conversation-source entries older than conversationMaxAge
 *
 * Manual and compaction memories are never pruned.
 */
export function collectGarbage(indexer: MemoryIndexer, config: Partial<GCConfig> = {}): GCResult {
  const { autoMaxAge, conversationMaxAge, dryRun } = { ...DEFAULT_CONFIG, ...config }
  const now = Date.now()
  const deleted: string[] = []
  let skipped = 0

  // Find stale auto-extracted memories (never accessed, old enough)
  const autoMemories = indexer.list(10000, 0, { source: 'auto' })
  for (const mem of autoMemories) {
    const age = now - mem.createdAt
    if (age < autoMaxAge) continue

    // Check full memory to see access count
    const full = indexer.get(mem.key)
    if (!full) continue

    if (full.accessCount > 0) {
      skipped++
      continue
    }

    if (dryRun) {
      log.info(
        'gc',
        `Would delete: ${mem.key} (auto, age=${Math.floor(age / 86_400_000)}d, accesses=0)`,
      )
    } else {
      indexer.delete(mem.key)
    }
    deleted.push(mem.key)
  }

  // Find old conversation-source entries
  const conversationMemories = indexer.list(10000, 0, { source: 'conversation' })
  for (const mem of conversationMemories) {
    const age = now - mem.createdAt
    if (age < conversationMaxAge) continue

    if (dryRun) {
      log.info(
        'gc',
        `Would delete: ${mem.key} (conversation, age=${Math.floor(age / 86_400_000)}d)`,
      )
    } else {
      indexer.delete(mem.key)
    }
    deleted.push(mem.key)
  }

  if (!dryRun && deleted.length > 0) {
    log.info('gc', `Garbage collected ${deleted.length} memories (${skipped} preserved by access)`)
  }

  return { deleted, skipped }
}
