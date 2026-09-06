import { describe, expect, test } from 'bun:test'
import { RepeatDetector } from '../../src/agent/tool-runner'

const run = { name: 'execute_command', arguments: { command: 'pytest -q' } }
const edit = { name: 'edit_file', arguments: { path: 'a.py', old_text: 'x', new_text: 'y' } }

describe('RepeatDetector', () => {
  test('running the tests again after an edit is not a loop', () => {
    const d = new RepeatDetector()
    expect(d.repeats([run])).toEqual([])
    expect(d.repeats([edit])).toEqual([])
    expect(d.repeats([run])).toEqual([])
  })

  test('the same call in the very next turn is a loop', () => {
    const d = new RepeatDetector()
    d.repeats([run])
    expect(d.repeats([run])).toEqual(['execute_command'])
  })

  test('a third occurrence is a loop even with other calls between', () => {
    const d = new RepeatDetector()
    d.repeats([run])
    d.repeats([edit])
    d.repeats([run])
    d.repeats([edit])
    expect(d.repeats([run])).toEqual(['execute_command'])
  })

  test('a batch that repeats itself is a loop', () => {
    const d = new RepeatDetector()
    d.repeats([run, edit])
    expect(d.repeats([run, edit])).toEqual(['execute_command', 'edit_file'])
  })

  test('different arguments are different calls', () => {
    const d = new RepeatDetector()
    d.repeats([run])
    expect(
      d.repeats([{ name: 'execute_command', arguments: { command: 'pytest -q -x' } }]),
    ).toEqual([])
  })
})
