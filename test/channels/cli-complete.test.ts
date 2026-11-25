/**
 * Tab completion and the dim inline suggestion: commands, their arguments, task names, and the
 * next step offered on an empty line.
 */

import { describe, expect, test } from 'bun:test'
import { complete, ghostFor, uniqueSuffix } from '../../src/channels/cli-complete'

const tasks = () => ['check-ci', 'petz4-re']
const completer = (line: string) => complete(line, tasks)

describe('complete', () => {
  test('completes command names from the slash', () => {
    expect(complete('/co').candidates).toEqual(['/context', '/compact', '/continue'])
    expect(complete('/maxt').candidates).toEqual(['/maxturns'])
  })

  test('completes a command argument', () => {
    expect(complete('/think h').candidates).toEqual(['high'])
    expect(complete('/maxturns ').candidates).toEqual(['10', '25', '50', '100'])
  })

  test('/tasks offers verbs and task names, and task names after a verb', () => {
    expect(completer('/tasks ').candidates).toEqual([
      'all',
      'run',
      'pause',
      'resume',
      'check-ci',
      'petz4-re',
    ])
    expect(completer('/tasks run ch').candidates).toEqual(['check-ci'])
    expect(completer('/tasks all x').candidates).toEqual([])
  })

  test('prose, unknown commands and finished words complete to nothing', () => {
    expect(complete('fix the bug').candidates).toEqual([])
    expect(complete('/etc/hosts is wrong').candidates).toEqual([])
    expect(complete('/think high').candidates).toEqual([])
  })
})

describe('uniqueSuffix', () => {
  test('is the rest of the one candidate, and nothing when there are several', () => {
    expect(uniqueSuffix(complete('/ta'))).toBe('sks')
    expect(uniqueSuffix(complete('/co'))).toBeUndefined()
  })
})

describe('ghostFor', () => {
  test('an empty line shows the suggestion, and → would take it', () => {
    expect(ghostFor('', '/continue', completer)).toEqual({ text: '/continue', accept: '/continue' })
    expect(ghostFor('', undefined, completer)).toBeUndefined()
  })

  test('a unique completion shows its rest; several show the choices, not acceptable', () => {
    expect(ghostFor('/ta', undefined, completer)).toEqual({ text: 'sks', accept: 'sks' })
    const choices = ghostFor('/co', undefined, completer)
    expect(choices?.text).toContain('/context /compact /continue')
    expect(choices?.accept).toBeUndefined()
  })

  test('typing replaces the suggestion with completion', () => {
    expect(ghostFor('hello', '/continue', completer)).toBeUndefined()
  })
})
