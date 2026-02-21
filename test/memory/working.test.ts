import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorkingMemory } from '../../src/memory/working'

describe('WorkingMemory', () => {
  let tmpDir: string
  let wm: WorkingMemory

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'egirl-working-mem-test-'))
    wm = new WorkingMemory(join(tmpDir, 'working.db'))
  })

  afterEach(() => {
    wm.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('set and get a working memory entry', () => {
    wm.set('current-task', 'reviewing PR #42', { context: 'github' })

    const entry = wm.get('current-task')
    expect(entry).not.toBeNull()
    expect(entry?.key).toBe('current-task')
    expect(entry?.value).toBe('reviewing PR #42')
    expect(entry?.context).toBe('github')
    expect(entry?.promote).toBe(false)
  })

  test('entries expire after TTL', () => {
    // Set with 0ms TTL (already expired)
    wm.set('ephemeral', 'gone soon', { ttlMs: 0 })

    // Should be swept on get
    const entry = wm.get('ephemeral')
    expect(entry).toBeNull()
  })

  test('getAll returns only non-expired entries', () => {
    wm.set('alive', 'still here', { ttlMs: 60000 })
    wm.set('dead', 'already gone', { ttlMs: 0 })

    const all = wm.getAll()
    expect(all.length).toBe(1)
    expect(all[0]?.key).toBe('alive')
  })

  test('delete removes an entry', () => {
    wm.set('doomed', 'goodbye')
    expect(wm.get('doomed')).not.toBeNull()

    const deleted = wm.delete('doomed')
    expect(deleted).toBe(true)
    expect(wm.get('doomed')).toBeNull()
  })

  test('delete returns false for missing key', () => {
    expect(wm.delete('nonexistent')).toBe(false)
  })

  test('markForPromotion flags an entry', () => {
    wm.set('important', 'remember this forever')

    const marked = wm.markForPromotion('important')
    expect(marked).toBe(true)

    const entry = wm.get('important')
    expect(entry?.promote).toBe(true)
  })

  test('promoted entries survive sweep even when expired', () => {
    wm.set('promoted', 'keep me', { ttlMs: 0 })
    wm.markForPromotion('promoted')

    // Sweep should not remove promoted entries
    const swept = wm.sweep()
    expect(swept).toBe(0)

    const candidates = wm.getPromotionCandidates()
    expect(candidates.length).toBe(1)
    expect(candidates[0]?.key).toBe('promoted')
  })

  test('count returns active entry count', () => {
    wm.set('a', 'alpha', { ttlMs: 60000 })
    wm.set('b', 'beta', { ttlMs: 60000 })
    wm.set('c', 'gamma', { ttlMs: 0 }) // expired

    expect(wm.count()).toBe(2)
  })

  test('set overwrites existing entry', () => {
    wm.set('key', 'value1')
    wm.set('key', 'value2')

    const entry = wm.get('key')
    expect(entry?.value).toBe('value2')
  })

  test('buildContext returns formatted string', () => {
    wm.set('task', 'building feature X', { context: 'dev', ttlMs: 60000 })

    const ctx = wm.buildContext()
    expect(ctx).toBeDefined()
    expect(ctx).toContain('[Active working memory:')
    expect(ctx).toContain('[task]')
    expect(ctx).toContain('building feature X')
    expect(ctx).toContain('expires in')
  })

  test('buildContext returns undefined when empty', () => {
    expect(wm.buildContext()).toBeUndefined()
  })

  test('default TTL is 1 hour', () => {
    wm.set('default-ttl', 'should last an hour')

    const entry = wm.get('default-ttl')
    expect(entry).not.toBeNull()
    // Should expire roughly 1 hour from now
    const expectedExpiry = Date.now() + 60 * 60 * 1000
    expect(entry?.expiresAt).toBeGreaterThan(expectedExpiry - 5000)
    expect(entry?.expiresAt).toBeLessThan(expectedExpiry + 5000)
  })
})
