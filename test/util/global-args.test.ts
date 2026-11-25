import { describe, expect, test } from 'bun:test'
import { parseGlobalArgs } from '../../src/util/args'

describe('parseGlobalArgs', () => {
  test('no command is the CLI', () => {
    expect(parseGlobalArgs([])).toEqual({ command: 'cli', commandArgs: [] })
  })

  test('`cli <name>` selects that instance', () => {
    expect(parseGlobalArgs(['cli', 'juno'])).toEqual({
      command: 'cli',
      commandArgs: [],
      instance: 'juno',
    })
    expect(parseGlobalArgs(['cli', 'juno', '-m', 'hi'])).toEqual({
      command: 'cli',
      commandArgs: ['-m', 'hi'],
      instance: 'juno',
    })
  })

  test('flags after cli are not a name, and --instance wins', () => {
    expect(parseGlobalArgs(['cli', '-m', 'hi']).instance).toBeUndefined()
    expect(parseGlobalArgs(['--instance', 'zero', 'cli', 'juno'])).toEqual({
      command: 'cli',
      commandArgs: ['juno'],
      instance: 'zero',
    })
  })

  test('only cli takes the short form', () => {
    expect(parseGlobalArgs(['new', 'zero'])).toEqual({ command: 'new', commandArgs: ['zero'] })
  })
})
