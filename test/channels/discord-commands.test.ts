/**
 * Discord application commands are a projection of the one command vocabulary: the same
 * names a user could type as text, registered so the client offers them with autocomplete.
 * The permission is enforced by the dispatcher, not by Discord; these pin the projection and
 * the caller identity a Discord user turns into.
 */
import { describe, expect, test } from 'bun:test'
import { buildApplicationCommands, callerFor } from '../../src/channels/discord-commands'

describe('buildApplicationCommands', () => {
  test('built-ins plus custom commands, with a string option when the command takes arguments', () => {
    const cmds = buildApplicationCommands([
      {
        name: 'draw',
        description: 'Draw a picture',
        args: 'what to draw',
        permission: 'everyone',
        skill: 'Draw',
      },
      { name: 'git', description: 'Git Ops skill', permission: 'owner', skill: 'Git Ops' },
    ])
    const names = cmds.map((c) => c.name)
    expect(names).toEqual(
      expect.arrayContaining(['status', 'think', 'context', 'help', 'draw', 'git']),
    )
    const draw = cmds.find((c) => c.name === 'draw')
    expect(draw?.description).toBe('Draw a picture')
    expect(draw?.options).toEqual([
      { type: 3, name: 'args', description: 'what to draw', required: false },
    ])
    expect(cmds.find((c) => c.name === 'git')?.options).toBeUndefined()
  })
  test('descriptions are clipped to what Discord accepts', () => {
    const [c] = buildApplicationCommands([
      { name: 'x', description: 'y'.repeat(300), permission: 'everyone', skill: 'x' },
    ]).filter((c) => c.name === 'x')
    expect(c?.description.length).toBeLessThanOrEqual(100)
  })
})

describe('callerFor', () => {
  const cfg = { allowedUsers: ['a', 'b'], ownerUsers: ['a'] }
  test('owner implies allowed; an empty allow list allows everyone but makes no one owner', () => {
    expect(callerFor('a', cfg)).toEqual({ userId: 'a', allowed: true, owner: true })
    expect(callerFor('b', cfg)).toEqual({ userId: 'b', allowed: true, owner: false })
    expect(callerFor('z', cfg)).toEqual({ userId: 'z', allowed: false, owner: false })
    expect(callerFor('z', { allowedUsers: [], ownerUsers: [] })).toEqual({
      userId: 'z',
      allowed: true,
      owner: false,
    })
  })
})
