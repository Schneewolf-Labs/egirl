import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTaskStore } from '../../src/tasks/store'
import { openDatabase, schemaVersion, stampSchemaVersion } from '../../src/util/db'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('openDatabase', () => {
  test('waits for a lock held by another process instead of failing on open', async () => {
    dir = mkdtempSync(join(tmpdir(), 'egirl-db-'))
    const path = join(dir, 'store.db')
    // A fresh (non-WAL) file locked by another process, as when a sibling egirl process is still
    // creating its schema: the first PRAGMA here must wait, not throw SQLITE_BUSY.
    const holder = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { Database } = require('bun:sqlite')
         const db = new Database(${JSON.stringify(path)})
         db.run('BEGIN EXCLUSIVE')
         db.run('CREATE TABLE t (x INTEGER)')
         console.log('locked')
         setTimeout(() => { db.run('COMMIT'); db.close() }, 700)`,
      ],
      { stdout: 'pipe' },
    )
    const reader = holder.stdout.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain('locked')

    const db = openDatabase(path)
    expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
    db.run('INSERT INTO t VALUES (1)')
    db.close()
    await holder.exited
  }, 15000)
})

describe('store schema versions', () => {
  const schema = { name: 'widgets', version: 2 }

  function freshPath(): string {
    dir = mkdtempSync(join(tmpdir(), 'egirl-db-'))
    return join(dir, 'store.db')
  }

  test('a new file reads as v0 until the store stamps it', () => {
    const db = openDatabase(freshPath(), schema)
    expect(schemaVersion(db)).toBe(0)
    stampSchemaVersion(db, schema)
    expect(schemaVersion(db)).toBe(2)
    db.close()
  })

  test('opens a file stamped with an older or equal version', () => {
    const path = freshPath()
    const old = openDatabase(path)
    stampSchemaVersion(old, { name: 'widgets', version: 1 })
    old.close()

    const db = openDatabase(path, schema)
    expect(schemaVersion(db)).toBe(1)
    db.close()
  })

  test('refuses a file written by newer code, naming the store and the fix', () => {
    const path = freshPath()
    const newer = openDatabase(path)
    stampSchemaVersion(newer, { name: 'widgets', version: 3 })
    newer.close()

    expect(() => openDatabase(path, schema)).toThrow(/widgets database is schema v3.*egirl update/)
  })

  test('a real store refuses a newer file instead of touching it', () => {
    const path = freshPath()
    const newer = openDatabase(path)
    stampSchemaVersion(newer, { name: 'tasks', version: 99 })
    newer.close()

    expect(() => createTaskStore(path)).toThrow('tasks database is schema v99')
    const after = openDatabase(path)
    const tables = after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    after.close()
    expect(tables).toEqual([])
  })

  test('a real store stamps its version on first open', () => {
    const path = freshPath()
    createTaskStore(path).close()
    const db = openDatabase(path)
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(1)
    db.close()
  })
})
