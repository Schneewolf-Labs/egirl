import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffLines, renderDiff } from '../../src/channels/cli-diff'
import { createEditDiffs } from '../../src/channels/cli-edit-diffs'

const plain = (s: string) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

describe('line diff', () => {
  test('keeps what is common and marks what changed', () => {
    const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e'])
    expect(ops.map((o) => `${o.kind[0]}${o.text}`)).toEqual(['sa', 'db', 'aB', 'sc', 'sd', 'ae'])
  })

  test('an insertion in the middle is only an insertion', () => {
    const ops = diffLines(['x', 'y'], ['x', 'new', 'y'])
    expect(ops.filter((o) => o.kind !== 'same')).toEqual([{ kind: 'add', text: 'new' }])
  })
})

describe('rendered diff', () => {
  const file = Array.from({ length: 30 }, (_, i) => `line ${i}`)

  test('shows each change with two lines of context and marks the gap between', () => {
    const after = [...file]
    after[5] = 'changed 5'
    after[25] = 'changed 25'
    const view = renderDiff(file.join('\n'), after.join('\n'))
    const rows = view?.lines.map(plain) ?? []
    expect(view?.added).toBe(2)
    expect(view?.removed).toBe(2)
    expect(rows).toEqual([
      '  line 3',
      '  line 4',
      '- line 5',
      '+ changed 5',
      '  line 6',
      '  line 7',
      '⋯',
      '  line 23',
      '  line 24',
      '- line 25',
      '+ changed 25',
      '  line 26',
      '  line 27',
    ])
  })

  test('is capped, and says how much it left out', () => {
    const view = renderDiff('', file.join('\n'), { maxLines: 5 })
    expect(view?.lines).toHaveLength(6)
    expect(plain(view?.lines[5] ?? '')).toBe('… +25 more diff lines')
  })

  test('no change, no diff', () => {
    expect(renderDiff('same\n', 'same\n')).toBeUndefined()
  })
})

describe('file tool diffs', () => {
  test('edit_file diffs its own old and new text', () => {
    const d = createEditDiffs(undefined)
    d.start({
      id: '1',
      name: 'edit_file',
      arguments: { path: 'a.ts', old_text: 'const x = 1\n', new_text: 'const x = 2\n' },
    })
    const out = d.finish('1', true, 80)?.map(plain)
    expect(out).toEqual(['a.ts +1 −1', '- const x = 1', '+ const x = 2'])
  })

  test('write_file diffs against the file as it was before the write', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cli-diff-'))
    writeFileSync(join(cwd, 'notes.md'), 'one\ntwo\n')
    const d = createEditDiffs(cwd)
    d.start({ id: '1', name: 'write_file', arguments: { path: 'notes.md', content: 'one\n2\n' } })
    writeFileSync(join(cwd, 'notes.md'), 'one\n2\n') // the tool runs
    expect(d.finish('1', true, 80)?.map(plain)).toEqual(['notes.md +1 −1', '  one', '- two', '+ 2'])
    d.start({ id: '2', name: 'write_file', arguments: { path: 'fresh.txt', content: 'hi\n' } })
    expect(d.finish('2', true, 80)?.map(plain)[0]).toBe('new file fresh.txt +1 −0')
  })

  test('a failed call or another tool shows nothing', () => {
    const d = createEditDiffs(undefined)
    d.start({ id: '1', name: 'edit_file', arguments: { path: 'a', old_text: 'x', new_text: 'y' } })
    expect(d.finish('1', false, 80)).toBeUndefined()
    d.start({ id: '2', name: 'read_file', arguments: { path: 'a' } })
    expect(d.finish('2', true, 80)).toBeUndefined()
  })
})
