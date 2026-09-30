import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { resolveUserPath } from '../../src/util/paths'

describe('resolveUserPath', () => {
  test('~ and ~/ mean home, not a directory named ~ in the workspace', () => {
    expect(resolveUserPath('~', '/ws', '/home/u')).toBe('/home/u')
    expect(resolveUserPath('~/inventory/repos.md', '/ws', '/home/u')).toBe(
      join('/home/u', 'inventory/repos.md'),
    )
  })

  test('relative paths stay relative to the workspace, absolute paths stay put', () => {
    expect(resolveUserPath('notes/a.md', '/ws', '/home/u')).toBe('/ws/notes/a.md')
    expect(resolveUserPath('/etc/hosts', '/ws', '/home/u')).toBe('/etc/hosts')
  })

  test('only a leading ~ is special', () => {
    expect(resolveUserPath('a/~/b', '/ws', '/home/u')).toBe('/ws/a/~/b')
    expect(resolveUserPath('~user/x', '/ws', '/home/u')).toBe('/ws/~user/x')
  })
})
