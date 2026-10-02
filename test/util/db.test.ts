import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDatabase } from '../../src/util/db'

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
