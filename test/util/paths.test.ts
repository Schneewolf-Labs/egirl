import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { resolveUserPath } from '../../src/util/paths'

describe('resolveUserPath', () => {
  test('~ and ~/ mean home, not a directory named ~ in the workspace', () => {
    expect(resolveUserPath('~', '/ws', '/home/u')).toBe(resolve('/home/u'))
    expect(resolveUserPath('~/inventory/repos.md', '/ws', '/home/u')).toBe(
      resolve('/home/u', 'inventory/repos.md'),
    )
  })

  test('relative paths resolve against the workspace, absolute paths resolve as themselves', () => {
    expect(resolveUserPath('notes/a.md', '/ws', '/home/u')).toBe(resolve('/ws', 'notes/a.md'))
    expect(resolveUserPath('/etc/hosts', '/ws', '/home/u')).toBe(resolve('/etc/hosts'))
  })

  test('only a leading ~ is special', () => {
    expect(resolveUserPath('a/~/b', '/ws', '/home/u')).toBe(resolve('/ws', 'a/~/b'))
    expect(resolveUserPath('~user/x', '/ws', '/home/u')).toBe(resolve('/ws', '~user/x'))
  })
})
