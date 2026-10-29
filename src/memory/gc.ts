import { log } from '../util/logger'
import type { MemoryIndexer } from './indexer'

export interface GCConfig {
  /** Max age (ms) for an extracted memory that was never recalled before it is pruned */
  autoMaxAge: number
  /** Dry run — log what would be deleted without actually deleting */
  dryRun: boolean
}

const DEFAULT_CONFIG: GCConfig = {
  autoMaxAge: 14 * 24 * 60 * 60 * 1000, // 14 days
  dryRun: false,
}

/**
 * Key prefixes of machine-written memories that may age out: facts the extractor pulled from a
 * conversation or task (`auto/`), and the permission supervisor's decision traces (`permission:`).
 * Everything else written with source 'auto' stays — `lesson/` entries are meant to last.
 */
const PRUNABLE_PREFIXES = ['auto/', 'permission:']

/** How often a long-running instance collects garbage after the startup pass. */
export const GC_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface GCResult {
  deleted: string[]
  skipped: number
}

/**
 * Garbage-collect stale memories: extracted facts and permission traces that are older than
 * autoMaxAge and were never recalled (search records an access on every hit).
 *
 * Never pruned: manual and compaction memories, lessons, and conversation-log chunks. The daily
 * log files are the source of truth for those chunks, and the log indexer re-adds any chunk
 * it finds missing, so deleting them would only churn.
 */
export function collectGarbage(indexer: MemoryIndexer, config: Partial<GCConfig> = {}): GCResult {
  const { autoMaxAge, dryRun } = { ...DEFAULT_CONFIG, ...config }
  const now = Date.now()
  const deleted: string[] = []
  let skipped = 0

  const autoMemories = indexer.list(10000, 0, { source: 'auto' })
  for (const mem of autoMemories) {
    if (!PRUNABLE_PREFIXES.some((prefix) => mem.key.startsWith(prefix))) continue
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
      log.info('gc', `Deleted: ${mem.key} (auto, age=${Math.floor(age / 86_400_000)}d, accesses=0)`)
    }
    deleted.push(mem.key)
  }

  if (!dryRun && deleted.length > 0) {
    log.info('gc', `Garbage collected ${deleted.length} memories (${skipped} preserved by access)`)
  }

  return { deleted, skipped }
}
