import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectGarbage } from '../../src/memory/gc'
import { MemoryIndexer } from '../../src/memory/indexer'

describe('Memory GC', () => {
  let tmpDir: string
  let indexer: MemoryIndexer

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'egirl-gc-test-'))
    const dbPath = join(tmpDir, 'test.db')
    indexer = new MemoryIndexer(dbPath, 4)
  })

  afterEach(() => {
    indexer.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('deletes old auto memories with zero accesses', () => {
    indexer.set('auto/old_fact', 'stale auto fact', { source: 'auto', category: 'fact' })

    // With a very short maxAge, the memory is immediately eligible
    const result = collectGarbage(indexer, { autoMaxAge: 0 })

    expect(result.deleted).toContain('auto/old_fact')
    expect(indexer.get('auto/old_fact')).toBeNull()
  })

  test('preserves auto memories that have been accessed', () => {
    indexer.set('auto/accessed_fact', 'accessed fact', { source: 'auto', category: 'fact' })
    indexer.recordAccess(['auto/accessed_fact'])

    const result = collectGarbage(indexer, { autoMaxAge: 0 })

    expect(result.deleted).not.toContain('auto/accessed_fact')
    expect(result.skipped).toBe(1)
    expect(indexer.get('auto/accessed_fact')).not.toBeNull()
  })

  test('preserves recent auto memories', () => {
    indexer.set('auto/recent', 'just created', { source: 'auto', category: 'fact' })

    // With a long maxAge, the memory is too young
    const result = collectGarbage(indexer, { autoMaxAge: 999_999_999 })

    expect(result.deleted).toHaveLength(0)
    expect(indexer.get('auto/recent')).not.toBeNull()
  })

  test('deletes old conversation-source memories', () => {
    indexer.set('log:2025-01-01:chunk0', 'old log chunk', {
      source: 'conversation',
      category: 'conversation',
    })

    const result = collectGarbage(indexer, { conversationMaxAge: 0 })

    expect(result.deleted).toContain('log:2025-01-01:chunk0')
    expect(indexer.get('log:2025-01-01:chunk0')).toBeNull()
  })

  test('preserves recent conversation memories', () => {
    indexer.set('log:today:chunk0', 'recent log', {
      source: 'conversation',
      category: 'conversation',
    })

    const result = collectGarbage(indexer, { conversationMaxAge: 999_999_999 })

    expect(result.deleted).toHaveLength(0)
    expect(indexer.get('log:today:chunk0')).not.toBeNull()
  })

  test('never deletes manual memories', () => {
    indexer.set('manual_fact', 'important', { source: 'manual', category: 'fact' })

    const result = collectGarbage(indexer, { autoMaxAge: 0, conversationMaxAge: 0 })

    expect(result.deleted).not.toContain('manual_fact')
    expect(indexer.get('manual_fact')).not.toBeNull()
  })

  test('never deletes compaction memories', () => {
    indexer.set('compaction/task_state', 'preserved', { source: 'compaction', category: 'project' })

    const result = collectGarbage(indexer, { autoMaxAge: 0, conversationMaxAge: 0 })

    expect(result.deleted).not.toContain('compaction/task_state')
    expect(indexer.get('compaction/task_state')).not.toBeNull()
  })

  test('dry run reports but does not delete', () => {
    indexer.set('auto/stale', 'will report', { source: 'auto', category: 'fact' })

    const result = collectGarbage(indexer, { autoMaxAge: 0, dryRun: true })

    expect(result.deleted).toContain('auto/stale')
    // Memory should still exist
    expect(indexer.get('auto/stale')).not.toBeNull()
  })

  test('returns correct counts for mixed scenario', () => {
    // Old auto, no access — will be deleted
    indexer.set('auto/stale1', 'old', { source: 'auto', category: 'fact' })
    indexer.set('auto/stale2', 'old', { source: 'auto', category: 'fact' })
    // Old auto, accessed — will be skipped
    indexer.set('auto/accessed', 'accessed', { source: 'auto', category: 'fact' })
    indexer.recordAccess(['auto/accessed'])
    // Old conversation — will be deleted
    indexer.set('log:old:0', 'old log', { source: 'conversation', category: 'conversation' })
    // Manual — untouched
    indexer.set('keep', 'manual', { source: 'manual', category: 'fact' })

    const result = collectGarbage(indexer, { autoMaxAge: 0, conversationMaxAge: 0 })

    expect(result.deleted).toHaveLength(3)
    expect(result.skipped).toBe(1)
    expect(indexer.count()).toBe(2) // auto/accessed + keep
  })
})
