import { describe, expect, test } from 'bun:test'
import { remapParamKeys } from '../../src/tools/fuzzy-match'

const SCHEMA = {
  type: 'object',
  properties: {
    file_path: { type: 'string' },
    command: { type: 'string' },
    working_dir: { type: 'string' },
    limit: { type: 'number' },
  },
  required: ['file_path'],
}

describe('remapParamKeys', () => {
  test('leaves valid keys alone', () => {
    const r = remapParamKeys({ file_path: '/tmp/a', limit: 5 }, SCHEMA)
    expect(r.remapped).toEqual([])
    expect(r.args).toEqual({ file_path: '/tmp/a', limit: 5 })
  })

  test('maps camelCase onto snake_case', () => {
    const r = remapParamKeys({ filePath: '/tmp/a' }, SCHEMA)
    expect(r.args).toEqual({ file_path: '/tmp/a' })
    expect(r.remapped).toEqual([{ from: 'filePath', to: 'file_path' }])
  })

  test('maps separator and case variants', () => {
    expect(remapParamKeys({ 'File-Path': 'x' }, SCHEMA).args).toEqual({ file_path: 'x' })
    expect(remapParamKeys({ WORKING_DIR: 'x' }, SCHEMA).args).toEqual({ working_dir: 'x' })
  })

  test('fixes a single-character typo', () => {
    const r = remapParamKeys({ commnd: 'ls' }, SCHEMA)
    expect(r.args).toEqual({ command: 'ls' })
    expect(r.remapped).toEqual([{ from: 'commnd', to: 'command' }])
  })

  test('does NOT remap when a key is too short to be unambiguous', () => {
    // 3 chars is below the edit-distance floor: `cmd` is one edit from nothing real here,
    // and guessing on tiny keys is how you feed a tool the wrong argument.
    const r = remapParamKeys({ cmd: 'ls' }, SCHEMA)
    expect(r.args).toEqual({ cmd: 'ls' })
    expect(r.remapped).toEqual([])
  })

  test('does NOT remap when two schema keys are equally close', () => {
    const ambiguous = {
      type: 'object',
      properties: { hosts: { type: 'string' }, ports: { type: 'string' } },
    }
    // "hosts"/"ports" are both one edit from "posts"
    const r = remapParamKeys({ posts: 'x' }, ambiguous)
    expect(r.args).toEqual({ posts: 'x' })
    expect(r.remapped).toEqual([])
  })

  test('never clobbers a key the model already supplied correctly', () => {
    const r = remapParamKeys({ file_path: '/real', filePath: '/bogus' }, SCHEMA)
    expect(r.args.file_path).toBe('/real')
    expect(r.remapped).toEqual([])
    expect(r.args.filePath).toBe('/bogus') // passed through, not silently dropped
  })

  test('passes unresolvable keys through rather than dropping them', () => {
    const r = remapParamKeys({ file_path: '/a', wildly_unrelated: 1 }, SCHEMA)
    expect(r.args).toEqual({ file_path: '/a', wildly_unrelated: 1 })
    expect(r.remapped).toEqual([])
  })

  test('is a no-op without a usable schema', () => {
    const args = { anything: 1 }
    expect(remapParamKeys(args, undefined).args).toBe(args)
    expect(remapParamKeys(args, { type: 'object' }).args).toBe(args)
  })

  test('two unknown keys competing for one target resolve deterministically', () => {
    const args = { filePath: 'a', file_pth: 'b' }
    const first = remapParamKeys(args, SCHEMA)
    for (let i = 0; i < 5; i++) {
      expect(remapParamKeys(args, SCHEMA)).toEqual(first)
    }
    // exactly one wins the target; the other survives untouched
    expect(first.remapped).toHaveLength(1)
    expect(Object.keys(first.args)).toHaveLength(2)
  })
})
