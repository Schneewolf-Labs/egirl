import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openSessionMap } from '../../src/operator/session-map'

describe('openSessionMap', () => {
  test('remembers which Claude session continues an egirl session, across reopening', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'egirl-claude-sessions-')), 'claude-sessions.json')
    const map = openSessionMap(path)
    expect(map.get('discord:1')).toBeUndefined()
    map.set('discord:1', 'aaaa-1')
    map.set('xmpp:default', 'bbbb-2')
    map.delete('xmpp:default')

    const reopened = openSessionMap(path)
    expect(reopened.get('discord:1')).toBe('aaaa-1')
    expect(reopened.get('xmpp:default')).toBeUndefined()
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ 'discord:1': 'aaaa-1' })
  })

  test('a damaged file means fresh sessions, not a crash', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'egirl-claude-sessions-')), 'claude-sessions.json')
    writeFileSync(path, '{not json')
    const map = openSessionMap(path)
    expect(map.get('x')).toBeUndefined()
    map.set('x', 'y')
    expect(openSessionMap(path).get('x')).toBe('y')
  })

  test("two processes on one file keep each other's entries", () => {
    const path = join(mkdtempSync(join(tmpdir(), 'egirl-claude-sessions-')), 'claude-sessions.json')
    const chat = openSessionMap(path)
    const tasks = openSessionMap(path)
    chat.set('discord:1', 'chat-session')
    tasks.set('task:heartbeat', 'task-session')
    chat.set('discord:2', 'other-chat')
    expect(tasks.get('discord:2')).toBe('other-chat')
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      'discord:1': 'chat-session',
      'task:heartbeat': 'task-session',
      'discord:2': 'other-chat',
    })
  })
})
