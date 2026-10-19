import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openClaudeSessionMap } from '../../src/operator/claude-sessions'

describe('openClaudeSessionMap', () => {
  test('remembers which Claude session continues an egirl session, across reopening', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'egirl-claude-sessions-')), 'claude-sessions.json')
    const map = openClaudeSessionMap(path)
    expect(map.get('discord:1')).toBeUndefined()
    map.set('discord:1', 'aaaa-1')
    map.set('xmpp:default', 'bbbb-2')
    map.delete('xmpp:default')

    const reopened = openClaudeSessionMap(path)
    expect(reopened.get('discord:1')).toBe('aaaa-1')
    expect(reopened.get('xmpp:default')).toBeUndefined()
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ 'discord:1': 'aaaa-1' })
  })

  test('a damaged file means fresh sessions, not a crash', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'egirl-claude-sessions-')), 'claude-sessions.json')
    writeFileSync(path, '{not json')
    const map = openClaudeSessionMap(path)
    expect(map.get('x')).toBeUndefined()
    map.set('x', 'y')
    expect(openClaudeSessionMap(path).get('x')).toBe('y')
  })
})
