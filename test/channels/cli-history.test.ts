import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendHistory, loadHistory } from '../../src/channels/cli-history'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'clihist-')), 'cli_history')

describe('cli input history', () => {
  test('lines saved by one run come back newest first in the next', () => {
    const path = fresh()
    appendHistory(path, '/status')
    appendHistory(path, 'fix the build')
    expect(loadHistory(path)).toEqual(['fix the build', '/status'])
  })

  test('no file is an empty history', () => {
    expect(loadHistory(fresh())).toEqual([])
  })

  test('blank and multi-line input is not saved', () => {
    const path = fresh()
    appendHistory(path, '   ')
    appendHistory(path, 'line one\nline two')
    appendHistory(path, '  kept  ')
    expect(loadHistory(path)).toEqual(['kept'])
  })

  test('repeats in a row collapse, and only the newest `limit` are kept', () => {
    const path = fresh()
    for (const l of ['a', 'b', 'b', 'c', 'd']) appendHistory(path, l)
    expect(loadHistory(path, 3)).toEqual(['d', 'c', 'b'])
  })

  test('a file far past the limit is cut back on load', () => {
    const path = fresh()
    writeFileSync(path, `${Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n')}\n`)
    expect(loadHistory(path, 10)[0]).toBe('l49')
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(10)
  })

  test.skipIf(process.platform === 'win32')('the file is private to its owner', () => {
    const path = fresh()
    appendHistory(path, 'secret-ish')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
