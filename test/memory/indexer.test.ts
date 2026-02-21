import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MemoryIndexer } from '../../src/memory/indexer'

describe('MemoryIndexer — categories and time ranges', () => {
  let tmpDir: string
  let indexer: MemoryIndexer

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'egirl-indexer-test-'))
    const dbPath = join(tmpDir, 'test.db')
    indexer = new MemoryIndexer(dbPath, 4)
  })

  afterEach(() => {
    indexer.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('stores and retrieves category and source', () => {
    indexer.set('pref', 'likes typescript', {
      category: 'preference',
      source: 'manual',
    })

    const mem = indexer.get('pref')
    expect(mem).not.toBeNull()
    expect(mem?.category).toBe('preference')
    expect(mem?.source).toBe('manual')
  })

  test('stores and retrieves session_id', () => {
    indexer.set('sess-mem', 'from a session', {
      category: 'conversation',
      source: 'auto',
      sessionId: 'discord:123',
    })

    const mem = indexer.get('sess-mem')
    expect(mem).not.toBeNull()
    expect(mem?.sessionId).toBe('discord:123')
  })

  test('defaults category to general and source to manual', () => {
    indexer.set('plain', 'no category specified')

    const mem = indexer.get('plain')
    expect(mem?.category).toBe('general')
    expect(mem?.source).toBe('manual')
  })

  test('getByCategory returns only matching category', () => {
    indexer.set('fact1', 'a fact', { category: 'fact' })
    indexer.set('pref1', 'a preference', { category: 'preference' })
    indexer.set('fact2', 'another fact', { category: 'fact' })

    const facts = indexer.getByCategory('fact')
    expect(facts.length).toBe(2)
    expect(facts.every((m) => m.category === 'fact')).toBe(true)
  })

  test('getByTimeRange returns memories within range', () => {
    const now = Date.now()

    // Set memories with different "creation" times by modifying the timestamp
    indexer.set('old', 'old memory', { category: 'fact' })
    indexer.set('new', 'new memory', { category: 'fact' })

    // All memories should be within the last second
    const recent = indexer.getByTimeRange(now - 1000, now + 1000)
    expect(recent.length).toBe(2)

    // Nothing from the future
    const future = indexer.getByTimeRange(now + 10000)
    expect(future.length).toBe(0)
  })

  test('list with category filter', () => {
    indexer.set('fact1', 'fact one', { category: 'fact' })
    indexer.set('pref1', 'pref one', { category: 'preference' })
    indexer.set('fact2', 'fact two', { category: 'fact' })

    const facts = indexer.list(100, 0, { category: 'fact' })
    expect(facts.length).toBe(2)
    expect(facts.every((m) => m.category === 'fact')).toBe(true)
  })

  test('list with source filter', () => {
    indexer.set('manual1', 'manual', { source: 'manual' })
    indexer.set('auto1', 'auto', { source: 'auto' })

    const autos = indexer.list(100, 0, { source: 'auto' })
    expect(autos.length).toBe(1)
    expect(autos[0]?.source).toBe('auto')
  })

  test('list with time range filter', () => {
    const now = Date.now()
    indexer.set('item1', 'content')
    indexer.set('item2', 'content')

    const recent = indexer.list(100, 0, { since: now - 1000, until: now + 1000 })
    expect(recent.length).toBe(2)

    const old = indexer.list(100, 0, { since: 0, until: now - 10000 })
    expect(old.length).toBe(0)
  })

  test('migration adds columns to existing databases', () => {
    // The constructor already handles migration, but we can verify
    // that the columns exist by writing and reading with new fields
    indexer.set('migrated', 'test value', {
      category: 'decision',
      source: 'auto',
      sessionId: 'test:session',
    })

    const mem = indexer.get('migrated')
    expect(mem?.category).toBe('decision')
    expect(mem?.source).toBe('auto')
    expect(mem?.sessionId).toBe('test:session')
  })

  test('new memories default to zero access tracking', () => {
    indexer.set('fresh', 'just created')

    const mem = indexer.get('fresh')
    expect(mem?.lastAccessedAt).toBe(0)
    expect(mem?.accessCount).toBe(0)
  })

  test('recordAccess updates last_accessed_at and access_count', () => {
    indexer.set('tracked', 'track me')

    indexer.recordAccess(['tracked'])
    const after1 = indexer.get('tracked')
    expect(after1?.accessCount).toBe(1)
    expect(after1?.lastAccessedAt).toBeGreaterThan(0)

    indexer.recordAccess(['tracked'])
    const after2 = indexer.get('tracked')
    expect(after2?.accessCount).toBe(2)
    expect(after2?.lastAccessedAt).toBeGreaterThanOrEqual(after1?.lastAccessedAt ?? 0)
  })

  test('recordAccess handles multiple keys', () => {
    indexer.set('a', 'alpha')
    indexer.set('b', 'beta')
    indexer.set('c', 'gamma')

    indexer.recordAccess(['a', 'c'])

    expect(indexer.get('a')?.accessCount).toBe(1)
    expect(indexer.get('b')?.accessCount).toBe(0)
    expect(indexer.get('c')?.accessCount).toBe(1)
  })

  test('recordAccess with empty array is a no-op', () => {
    indexer.set('untouched', 'should not change')
    indexer.recordAccess([])
    expect(indexer.get('untouched')?.accessCount).toBe(0)
  })
})

describe('MemoryIndexer — key collision resolution', () => {
  let tmpDir: string
  let indexer: MemoryIndexer

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'egirl-indexer-collision-'))
    const dbPath = join(tmpDir, 'test.db')
    indexer = new MemoryIndexer(dbPath, 4)
  })

  afterEach(() => {
    indexer.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('auto key from same session overwrites normally', () => {
    indexer.set('auto/preferred_language', 'Python', {
      source: 'auto',
      sessionId: 'session-a',
      category: 'preference',
    })
    indexer.set('auto/preferred_language', 'Rust', {
      source: 'auto',
      sessionId: 'session-a',
      category: 'preference',
    })

    const mem = indexer.get('auto/preferred_language')
    expect(mem?.value).toBe('Rust')
    expect(indexer.count()).toBe(1)
  })

  test('auto key from different session gets suffixed instead of overwriting', () => {
    indexer.set('auto/preferred_language', 'Python', {
      source: 'auto',
      sessionId: 'session-a',
      category: 'preference',
    })
    const actualKey = indexer.set('auto/preferred_language', 'Rust', {
      source: 'auto',
      sessionId: 'session-b',
      category: 'preference',
    })

    // Original preserved
    const original = indexer.get('auto/preferred_language')
    expect(original?.value).toBe('Python')
    expect(original?.sessionId).toBe('session-a')

    // New value stored under suffixed key
    expect(actualKey).toBe('auto/preferred_language_2')
    const suffixed = indexer.get('auto/preferred_language_2')
    expect(suffixed?.value).toBe('Rust')
    expect(suffixed?.sessionId).toBe('session-b')

    expect(indexer.count()).toBe(2)
  })

  test('multiple collisions increment suffix', () => {
    indexer.set('auto/editor', 'vim', {
      source: 'auto',
      sessionId: 'session-a',
      category: 'preference',
    })
    indexer.set('auto/editor', 'emacs', {
      source: 'auto',
      sessionId: 'session-b',
      category: 'preference',
    })
    const thirdKey = indexer.set('auto/editor', 'nano', {
      source: 'auto',
      sessionId: 'session-c',
      category: 'preference',
    })

    expect(indexer.get('auto/editor')?.value).toBe('vim')
    expect(indexer.get('auto/editor_2')?.value).toBe('emacs')
    expect(thirdKey).toBe('auto/editor_3')
    expect(indexer.get('auto/editor_3')?.value).toBe('nano')
    expect(indexer.count()).toBe(3)
  })

  test('suffixed key reused by same session updates in place', () => {
    indexer.set('auto/lang', 'Python', {
      source: 'auto',
      sessionId: 'session-a',
      category: 'preference',
    })
    indexer.set('auto/lang', 'Rust', {
      source: 'auto',
      sessionId: 'session-b',
      category: 'preference',
    })
    // session-b writes again — should reuse auto/lang_2
    const key = indexer.set('auto/lang', 'Go', {
      source: 'auto',
      sessionId: 'session-b',
      category: 'preference',
    })

    expect(key).toBe('auto/lang_2')
    expect(indexer.get('auto/lang_2')?.value).toBe('Go')
    expect(indexer.count()).toBe(2)
  })

  test('compaction keys also get collision resolution', () => {
    indexer.set('compaction/task_status', 'building feature X', {
      source: 'compaction',
      sessionId: 'session-a',
      category: 'project',
    })
    const actualKey = indexer.set('compaction/task_status', 'debugging feature Y', {
      source: 'compaction',
      sessionId: 'session-b',
      category: 'project',
    })

    expect(indexer.get('compaction/task_status')?.value).toBe('building feature X')
    expect(actualKey).toBe('compaction/task_status_2')
    expect(indexer.get('compaction/task_status_2')?.value).toBe('debugging feature Y')
  })

  test('manual source keys are not affected by collision resolution', () => {
    indexer.set('my_key', 'value 1', {
      source: 'manual',
      sessionId: 'session-a',
    })
    indexer.set('my_key', 'value 2', {
      source: 'manual',
      sessionId: 'session-b',
    })

    // Manual keys always overwrite (existing behavior)
    expect(indexer.get('my_key')?.value).toBe('value 2')
    expect(indexer.count()).toBe(1)
  })

  test('auto key without sessionId overwrites normally', () => {
    indexer.set('auto/key', 'first', {
      source: 'auto',
      sessionId: 'session-a',
      category: 'fact',
    })
    indexer.set('auto/key', 'second', {
      source: 'auto',
      category: 'fact',
    })

    // No sessionId on second write — collision resolution skipped, overwrites
    expect(indexer.get('auto/key')?.value).toBe('second')
    expect(indexer.count()).toBe(1)
  })

  test('set returns the actual key used', () => {
    const key1 = indexer.set('auto/thing', 'first', {
      source: 'auto',
      sessionId: 'session-a',
      category: 'fact',
    })
    const key2 = indexer.set('auto/thing', 'second', {
      source: 'auto',
      sessionId: 'session-b',
      category: 'fact',
    })

    expect(key1).toBe('auto/thing')
    expect(key2).toBe('auto/thing_2')
  })
})
